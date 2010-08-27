var http = require('http');
var url = require('url');
var sys = require('sys');
var fs = require('fs');
var querystring = require('querystring');

global.http_temp_count = 0;

var http_subparse = require('./http_subparse');

var http_utils = exports;

//
// tokens used in the HTTP spec
//

var token = "([!#$%&'*+-.^_`|~0-9A-Za-z]+)";
var qstring = "(?:\"((?:\\.|[\t !#-~])*)\")";
var lws = "(?:(?:\r\n)?[ \t]+)?";


// See:
// http://www.w3.org/Protocols/rfc2616/rfc2616-sec3.html#sec3.6
// http://www.w3.org/Protocols/rfc2616/rfc2616-sec3.html#sec3.7
//
// Content-type & some other headers are defined as:
//   [multiple-headers]	= token *( ";" parameter )
//   parameter		= attribute "=" value
//   attribute		= token
//   value		= token | quoted-string
//
// We can't just split the header on semi colons because they
// can be used in quoted strings. Hurray!

exports.parse_header = function(h, s){


	var out = { full: s };
	var m;


	if (h == 'content-type' || h == 'accept'){

		var rx = new RegExp('^'+lws+token+lws+'/'+lws+token);
		var m = rx.exec(s);
		if (!m) return out;

		out.fulltype = m[1]+'/'+m[2];
		out.type = m[1];
		out.subtype = m[2];
		s = s.substr(m[0].length);

		return parse_header_extensions(s, out);
	}

	if (h == 'transfer-encoding' || h == 'content-disposition'){

		var rx = new RegExp('^'+lws+token);
		var m = rx.exec(s);
		if (!m) return out;
		
		out.base = m[1];
		s = s.substr(m[0].length);

		return parse_header_extensions(s, out);
	}

	return out;
}

function parse_header_extensions(s, out){

	var m;

	//
	// we loop, finding ";token=token/qstring" pairs
	//

	var full_rx = new RegExp('^'+lws+';'+lws+token+lws+'='+lws+'('+qstring+'|'+token+')');

	while (1){

		m = full_rx.exec(s);
		if (!m) return out;

		// we can't just read m[2] because we want to skip the quotes
		// if it was a qstring
		if (m[3]){
			out[m[1]] = m[3];
		}else{
			out[m[1]] = m[4];
		}

		s = s.substr(m[0].length);		
	}
}


//
// a simple subclass of http.createServer which doesn't fire the callback until
// the request body has been buffered, but only if we care about its contents.
// we also parse out get and post args.
//

exports.createSimpleServer = function(callback){

	return http.createServer(function (req, res) {

		req.body = null;
		//req.setEncoding(null); // Buffer pls

		var _url = url.parse(req.url, true);
		req.get = _url.query || {};
		req.post = {};
		req.files = {};


		//
		// do we want to wait for the body?
		//

		var wait_for_body = 0;

		var content_type = http_utils.parse_header('content-type', req.headers['content-type']);

		if (req.method == 'POST'){
			if (content_type.fulltype == 'application/x-www-form-urlencoded'){

				wait_for_body = 'url';
				req.body = '';
			}

			if (content_type.fulltype == 'multipart/form-data'){

				wait_for_body = 'multi';
				req.parser = multipart_stream_parser(content_type.boundary);
			}
		}


		//
		// get on with it
		//

		if (wait_for_body){

			req.on('data', function(chunk){

				if (wait_for_body == 'url'){

					req.body += chunk.toString();
				}

				if (wait_for_body == 'multi'){

					req.parser.onData(chunk);
				}
			});

			req.on('end', function(){

				if (wait_for_body == 'url'){
					req.post = querystring.parse(req.body);
				}

				if (wait_for_body == 'multi'){

					req.post = req.parser.post;
					req.files = req.parser.files;
				}

				callback(req, res);

				if (wait_for_body == 'multi'){

					// after the callback has returned we'll be deleting the files.
					// TODO: this seems like it's too soon. we want to do it when
					// 'req' objects goes out of scope. somehow
					req.parser.cleanup();
				}
			});
		}else{

			callback(req, res);
		}
	});
};


function multipart_stream_parser(boundary){

	//
	// parser states:
	//
	// 0: beginning (not yet found first boundary)
	// 1: within boundary, sub-parser active
	// 2: passed final marker
	//

	var parser = {};

	parser.boundary = boundary;
	parser.buffer = null;
	parser.state = 0; // not in chunk
	parser.subparser = new http_subparse.HTTPSubParser();

	parser.post = {};
	parser.files = {};

	parser.onData = function(b){

		//console.log('onData '+b.length);
		parser.appendChunk(b);


		//
		// we're before the first boundary. search for the start.
		// if we find it, we'll roll down into the next state
		//

		if (parser.state == 0){

			var s = parser.buffer.toString();
			var find = '--'+parser.boundary+"\r\n";
			var idx = s.indexOf(find);

			if (idx > -1){
				//console.log('found first boundary at '+idx);
				parser.fastForward(idx + find.length);
				parser.subparser.startStream();
				parser.state = 1;
			}
		}


		//
		// inside a stream
		//

		if (parser.state == 1 && parser.buffer){

			while (parser.processBuffer()){
				//console.log('parser.processBuffer returned true - repeating');
			}

			//console.log('parser.processBuffer returned false');
		}


		//
		// just ignore any data that comes after we've ended
		//
	};


	//
	// append a buffer into our local buffer
	//

	parser.appendChunk = function(b){

		if (parser.buffer){

			var new_buffer = new Buffer(parser.buffer.length + b.length);
			parser.buffer.copy(new_buffer, 0, 0);
			b.copy(new_buffer, parser.buffer.length, 0);
			parser.buffer = new_buffer;
		}else{
			parser.buffer = b;
		}
	}

	parser.fastForward = function(l){
		//console.log('fast forward '+l+' bytes');
		if (parser.buffer){
			var current_l = parser.buffer.length;
			if (l < current_l){
				parser.buffer = parser.buffer.slice(l, current_l);
				//console.log('buffer now '+parser.buffer.length+' bytes');
			}else{
				//console.log('buffer now empty');
				parser.buffer = null;
			}
		}else{
			//console.log('no buffer to move through');
		}
	}

	parser.cleanup = function(){

		// TODO: clean up files here
	}

	// return true to continue!
	parser.processBuffer = function(){

		if (!parser.buffer){
			//console.log('no buffer to process');
			return false;
		}

		var s = parser.buffer.toString();

		//
		// first, test for the end of the current
		// chunk and the start of the next
		//

		var find = '\r\n--'+parser.boundary+"\r\n";
		var idx = s.indexOf(find);

		if (idx > -1){
			//console.log('found next bounary at '+idx);
			parser.subparser.endStream(parser.buffer.slice(0, idx));
			parser.fastForward(idx + find.length);
			parser.subparser.startStream();
			return true;
		}


		//
		// next, test for the final chunk marker
		//

		find = '\r\n--'+parser.boundary+"--";
		idx = s.indexOf(find);

		if (idx > -1){
			//console.log('found final bounary at '+idx);
			parser.subparser.endStream(parser.buffer.slice(0, idx));
			parser.fastForward(idx + find.length);
			parser.state = 2;
			return true;
		}


		//
		// nope - no markers found. feed the whole
		// buffer into the current parser
		//
		// we will only feed up to buffer.len - delimiter.len
		// bytes, else we might end up feeding half of a 
		// delimiter and so never catch the boundary. don't
		// worry - the data left in our buffer will get appended
		// to and eventually fed into the parser.
		//

		var ok_feed_len = parser.buffer.length - find.length;
		if (ok_feed_len > 0){

			//console.log('feeding middle bytes: '+ok_feed_len);

			parser.subparser.streamData(parser.buffer.slice(0, ok_feed_len));
			parser.fastForward(ok_feed_len);
		}

		return false;
	}


	//
	// these callbacks are called as we parse the part
	//

	parser.start_part = function(){
		parser.part_type = null;
		parser.part_disp = null;
		parser.part_buffer = null;
		parser.part_filename = null;
		parser.part_fd = null
		parser.part_size = 0;
	}

	parser.start_part();

	parser.subparser.on('headers', function(headers){

		parser.headers = headers;

		if (headers['content-disposition']){
			var dis = http_utils.parse_header('content-disposition', headers['content-disposition']);

			if (dis.base == 'form-data' && dis.name){

				if (dis.filename){

					parser.part_type = 'file';
					parser.part_disp = dis;
					parser.part_filename = parser.getTempFilename();
					parser.part_fd = fs.openSync(parser.part_filename, 'w');
					parser.part_size = 0;

				}else{
					parser.part_type = 'form';
					parser.part_disp = dis;
					parser.part_buffer = '';
				}
			}
		}

	});

	parser.subparser.on('data', function(b){

		if (parser.part_type == 'form'){
			parser.part_buffer += b.toString();
		}

		if (parser.part_type == 'file'){
			parser.part_size += b.length;
			fs.writeSync(parser.part_fd, b, 0, b.length);
		}
	});

	parser.subparser.on('end', function(){

		if (parser.part_type == 'form'){

			parser.post[parser.part_disp.name] = parser.part_buffer;
		}

		if (parser.part_type == 'file'){

			fs.closeSync(parser.part_fd);

			parser.files[parser.part_disp.name] = {
				'type'		: parser.headers['content-type'],
				'size'		: parser.part_size,
				'orig_name'	: parser.part_disp.filename,
				'temp_name'	: parser.part_filename,
			};
		}

		parser.start_part();
	});

	parser.getTempFilename = function(){
		global.http_temp_count++;
		return '/tmp/node-'+global.http_temp_count;
	}


	return parser;
}
