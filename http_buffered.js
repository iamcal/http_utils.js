var http = require('http');
var url = require('url');
var querystring = require('querystring');
var http_utils = require('./http_utils');

//
// a simple subclass of http.createServer which doesn't fire the callback until
// the request body has been buffered, but only if we care about its contents.
// we also parse out get and post args.
//

exports.createServer = function(callback){

	return http.createServer(function (req, res) {

		//console.log(req.headers);

		req.body = "";
		req.setEncoding(encoding='utf8');

		var _url = url.parse(req.url, true);
		req._get = _url.query || {};
		req._post = {};


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
				req.body += chunk;
			});

			req.on('end', function(){

				if (wait_for_body == 'url'){
					//console.log('parsing url encoded body args');
					req._post = querystring.parse(req.body);
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
