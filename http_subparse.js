var sys = require('sys');

var HTTPParser = process.binding('http_parser').HTTPParser;

exports.execute = function(b){

	// we pass this to the parser first so that it thinks it's a full incoming response
	var rb = new Buffer("HTTP/1.0 200 OK\r\n", 'ascii');

	var parser = make_parser();
	parser.reinitialize('response');
	parser.execute(rb, 0, rb.length);
	parser.execute(b, 0, b.length);
	parser.finish();

	return parser.out;
}

function make_parser(){

	var parser = new HTTPParser('response');

	parser.out = {
		headers: {},
		body: null,
	};

	parser.decoder = null;

	parser.setEncoding = function(encoding){
		var StringDecoder = require("string_decoder").StringDecoder; // lazy load
		parser.decoder = new StringDecoder(encoding);
	}

	parser.addHeaderLine = function(k, v){
		parser.out.headers[k] = v;
	}

	parser.addData = function(b){
		//console.log('parser.addData : '+b.length);

		if (parser.out.body){
			var n = new Buffer(parser.out.body.length + b.length);
			parser.out.body.copy(n, 0, 0);
			b.copy(n, parser.out.body.length, 0);
			parser.out.body = n;
		}else{
			parser.out.body = b;
		}
	}


	//
	// hooks to the real parser
	//

	parser.onMessageBegin = function () {
		//console.log('parser.onMessageBegin');
		parser.field = null;
		parser.value = null;
	};

	parser.onURL = function (b, start, len) {
		//console.log('parser.onURL');
	}

	parser.onHeaderField = function (b, start, len) {
		//console.log('parser.onHeaderField');
		var slice = b.toString('ascii', start, start+len).toLowerCase();
		if (parser.value != undefined) {
			parser.addHeaderLine(parser.field, parser.value);
			parser.field = null;
			parser.value = null;
		}
		if (parser.field) {
			parser.field += slice;
		} else {
			parser.field = slice;
		}
	};

	parser.onHeaderValue = function (b, start, len) {
		//console.log('parser.onHeaderValue');
		var slice = b.toString('ascii', start, start+len);
		if (parser.value){
			parser.value += slice;
		} else {
			parser.value = slice;
		}
	};

	parser.onHeadersComplete = function (info) {
		//console.log('parser.onHeadersComplete');
		//console.log(sys.inspect(info));

		if (parser.field && (parser.value != undefined)) {
			parser.addHeaderLine(parser.field, parser.value);
		}

		return false;
	};

	parser.onBody = function (b, start, len) {
		//console.log('parser.onBody');
		var slice = b.slice(start, start+len);
		if (parser.decoder) {
			var string = parser.decoder.write(slice);
			if (string.length){
				parser.addData(string);
			}
		} else {
			parser.addData(slice);
		}
	};

	parser.onMessageComplete = function () {
		//console.log('parser.onMessageComplete');
	};

	return parser;
}
