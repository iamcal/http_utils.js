var http_utils = require('./http_utils');
var sys = require('sys');

http_utils.createSimpleServer(function (req, res) {

	res.writeHead(200, {'Content-Type': 'text/plain'});
	res.end('REQUEST: '+ sys.inspect(req)+"\n\n", 'utf8');

}).listen(8124);

console.log('Server running at http://127.0.0.1:8124/');
