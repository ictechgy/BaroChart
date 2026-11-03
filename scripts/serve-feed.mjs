import {resolve} from 'node:path';
import {createDemoServer} from './serve.mjs';
import {createFeedFixture} from './feed-fixture.mjs';

export function createFeedDemoServer(options={}){
 const fixture=createFeedFixture(options),server=createDemoServer({handleApi:fixture.handleApi});
 const close=server.close.bind(server);server.close=callback=>{fixture.close();server.closeIdleConnections();return close(callback);};return server;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const port=Number(process.env.PORT??5190),server=createFeedDemoServer();server.listen(port,'127.0.0.1',()=>console.log('Feed demo: http://127.0.0.1:'+port+'/examples/web/feed.html'));
 const stop=()=>server.close(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
