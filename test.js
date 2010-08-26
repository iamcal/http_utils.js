var http_utils = require('./http_utils');
var sys = require('sys');

http_utils.createSimpleServer(function (req, res) {

	res.writeHead(200, {'Content-Type': 'text/plain'});
	res.write('GET: '+ sys.inspect(req.get)+"\n", 'utf8');
	res.write('POST: '+ sys.inspect(req.post)+"\n", 'utf8');
	res.end();

}).listen(8124);

console.log('Server running at http://127.0.0.1:8124/');
