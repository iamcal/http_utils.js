var http = require('http');
var url = require('url');
var sys = require('sys');
var querystring = require('querystring');

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
	parser.subparser = http_subparse.createParser();

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
			}
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
		if (parser.buffer){
			var current_l = parser.buffer.length;
			if (l < current_l){
				parser.buffer = parser.buffer.slice(l, current_l);
			}else{
				parser.buffer = null;
			}
		}
	}

	// return true to continue!
	parser.processBuffer = function(){

		if (!parser.buffer) return false;

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
			parser.processPart(parser.subparser.out);
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
			parser.processPart(parser.subparser.out);
			parser.fastForward(idx + find.length);
			parser.state = 2;
			return true;
		}


		//
		// nope - no markers found. feed the whole
		// buffer into the current parser
		//

	// ***************************************************************************
	// TODO: There is a fairly serious bug here where
	// if we're fed half of a delimiter then we will
	// never detect it. when we don't find a delimiter,
	// we need to only pass as much of the buffer as
	// can't possibly contain the next one (buffer.len - delimiter.len)
	// ***************************************************************************

		parser.subparser.streamData(parser.buffer);
		parser.buffer = null;

		return false;
	}


	//
	// this is where we figure out what we got (if anything) from
	// the part we just finished processing.
	//

	parser.processPart = function(part){

		if (part.headers['content-disposition']){

			var dis = http_utils.parse_header('content-disposition', part.headers['content-disposition']);

			if (dis.base == 'form-data' && dis.name){

				parser.post[dis.name] = part.body.toString();
			}
		}

	}

	return parser;
}
