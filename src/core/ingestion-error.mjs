export class IngestionError extends Error {
 constructor(code,message,cause){super(message);this.name='IngestionError';this.code=code;if(cause!==undefined)this.cause=cause;}
}
