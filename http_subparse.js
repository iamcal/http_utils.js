var sys = require('sys');
var events = require('events');

var HTTPParser = process.binding('http_parser').HTTPParser;

function HTTPSubParser(){
	events.EventEmitter.call(this);

	this.parser = make_parser(this);
	this.running = false;
	this.rb = new Buffer("HTTP/1.0 200 OK\r\n", 'ascii');
	this.out = null;
	this.decoer = null;

	return this;
}
sys.inherits(HTTPSubParser, events.EventEmitter);
exports.HTTPSubParser = HTTPSubParser;


//
// public interface
//

HTTPSubParser.prototype.startStream = function(b){

	if (this.running) this.end();
	this.running = true;
	this.reset();

	this.parser.reinitialize('response');
	this.parser.execute(this.rb, 0, this.rb.length);
	if (b) this.streamData(b);
}

HTTPSubParser.prototype.endStream = function(b){

	if (b) this.streamData(b);
	this.parser.finish();
	this.running = false;
	return this.out;
}

HTTPSubParser.prototype.streamData = function(b){

	this.parser.execute(b, 0, b.length);
}


//
// internals
//

HTTPSubParser.prototype.reset = function(){

	this.out = {
		headers: {},
		body: null,
	};

	this.decoder = null;
}

HTTPSubParser.prototype.setEncoding = function(encoding){
	var StringDecoder = require("string_decoder").StringDecoder; // lazy load
	this.decoder = new StringDecoder(encoding);
}

HTTPSubParser.prototype.addHeaderLine = function(k, v){
	this.out.headers[k] = v;
}

HTTPSubParser.prototype.addData = function(b){
	if (this.out.body){
		var n = new Buffer(this.out.body.length + b.length);
		this.out.body.copy(n, 0, 0);
		b.copy(n, this.out.body.length, 0);
		this.out.body = n;
	}else{
		this.out.body = b;
	}
}





exports.createParser = function(){

	var parser = make_parser();
	parser.running = false;
	parser.rb = new Buffer("HTTP/1.0 200 OK\r\n", 'ascii');

	parser.startStream = function(b){

		if (parser.running) parser.end();
		parser.running = true;
		parser.reset();

		parser.reinitialize('response');
	        parser.execute(parser.rb, 0, parser.rb.length);
		if (b) parser.streamData(b);
	};

	parser.streamData = function(b){

		parser.execute(b, 0, b.length);
	}

	parser.endStream = function(b){

		if (b) parser.streamData(b);

		parser.finish();
		parser.running = false;
		return parser.out;
	}

	return parser;
}



function make_parser(owner){

	var parser = new HTTPParser('response');

	parser.owner = owner;

//	parser.reset = function(){
//		parser.out = {
//			headers: {},
//			body: null,
//		};
//
//		parser.decoder = null;
//	}

//	parser.reset();

//	parser.setEncoding = function(encoding){
//		var StringDecoder = require("string_decoder").StringDecoder; // lazy load
//		parser.decoder = new StringDecoder(encoding);
//	}

//	parser.addHeaderLine = function(k, v){
//		parser.out.headers[k] = v;
//	}

//	parser.addData = function(b){
//		//console.log('parser.addData : '+b.length);
//
//		if (parser.out.body){
///			var n = new Buffer(parser.out.body.length + b.length);
//			parser.out.body.copy(n, 0, 0);
//			b.copy(n, parser.out.body.length, 0);
//			parser.out.body = n;
//		}else{
//			parser.out.body = b;
//		}
//	}


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
			parser.owner.addHeaderLine(parser.field, parser.value);
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
			parser.owner.addHeaderLine(parser.field, parser.value);
		}

		return false;
	};

	parser.onBody = function (b, start, len) {
		//console.log('parser.onBody');
		var slice = b.slice(start, start+len);
		if (parser.decoder) {
			var string = parser.decoder.write(slice);
			if (string.length){
				parser.owner.addData(string);
			}
		} else {
			parser.owner.addData(slice);
		}
	};

	parser.onMessageComplete = function () {
		//console.log('parser.onMessageComplete');
	};

	return parser;
}



