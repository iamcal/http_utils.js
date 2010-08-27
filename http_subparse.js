var sys = require('sys');
var events = require('events');

var HTTPParser = process.binding('http_parser').HTTPParser;

function HTTPSubParser(){
	events.EventEmitter.call(this);

	this.parser = make_parser(this);
	this.running = false;
	this.rb = new Buffer("HTTP/1.0 200 OK\r\n", 'ascii');
	this.headers = null;
	this.decoder = null;

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

	this.headers = {};
	this.decoder = null;
}

HTTPSubParser.prototype.setEncoding = function(encoding){
	var StringDecoder = require("string_decoder").StringDecoder; // lazy load
	this.decoder = new StringDecoder(encoding);
}

HTTPSubParser.prototype.addHeaderLine = function(k, v){
	this.headers[k] = v;
}

HTTPSubParser.prototype.headersComplete = function(){
	this.emit('headers', this.headers);
}

HTTPSubParser.prototype.addData = function(b){
	this.emit('data', b);
}

HTTPSubParser.prototype.allDone = function(){
	this.emit('end');
}


//
// this private function encapsulates the HTTPParser object
//

function make_parser(owner){

	var parser = new HTTPParser('response');

	parser.owner = owner;

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
		parser.owner.headersComplete();

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
		parser.owner.allDone();
	};

	return parser;
}



