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

exports.parse_multipart = function(bound, body){

	// TODO: this should use buffers instead of strings

	var raw_parts = body.split('--'+bound);

	var parts = [];
	for (var i=0; i<raw_parts.length; i++){
		var p = raw_parts[i];
		var l = p.length

		if (p.substr(0, 2) == "\r\n" && p.substr(l-2, 2) == "\r\n"){

			parts.push(http_subparse.execute(new Buffer(p.substr(2, l-4))));
		}
	}

	return parts;
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
					//console.log('parsing url encoded body args');
					req.post = querystring.parse(req.body);
				}

				if (wait_for_body == 'multi'){

					req.post = req.parser.post;
					req.files = req.parser.files;
				}
				
				if (0){	
					var parts = http_utils.parse_multipart(content_type.boundary, req.body);

					for (var i=0; i<parts.length; i++){

						console.log(parts[i].headers);

						if (parts[i].headers['content-disposition']){

							var dis = http_utils.parse_header('content-disposition', parts[i].headers['content-disposition']);
							if (dis.base == 'form-data' && dis.name){
								console.log(dis);

								req.post[dis.name] = parts[i].body.toString();
							}
						}
					}
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
	// 2: within boundary, sub-parser active
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
		// if we find it, we'll roll down into the next stare
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

		// first, test for the end of the current
		// chunk and the start of the next

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


		// next, test for the final chunk marker
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

		// nope - no markers found. feed the whole
		// buffer into the current parser
		parser.subparser.streamData(parser.buffer);
		parser.buffer = null;

		return false;
	}

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
