var http = require('http');
var url = require('url');
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

	if (h == 'transfer-encoding'){

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
		req.setEncoding(encoding='utf8');

		var _url = url.parse(req.url, true);
		req.get = _url.query || {};
		req.post = {};


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
				req.body_bound = content_type.boundary;
			}
		}


		//
		// get on with it
		//

		if (wait_for_body){

			req.on('data', function(chunk){
				if (req.body){
					req.body += chunk;
				}else{
					req.body = chunk;
				}
			});

			req.on('end', function(){

				if (wait_for_body == 'url'){
					//console.log('parsing url encoded body args');
					req.post = querystring.parse(req.body);
				}

				if (wait_for_body == 'multi'){

					// TODO: this should stream the request to the multipart pasrer, rather
					// than buffer it all up first.
					req.parts = http_utils.parse_multipart(content_type.boundary, req.body);

					//console.log('MULTIPART!');
					//console.log(content_type.boundary);
					//console.log(req.body);
				}

				callback(req, res);
			});
		}else{

			callback(req, res);
		}
	});
};
