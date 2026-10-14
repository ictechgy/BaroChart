package dev.aster.charts;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Internal entry-only ownership machine. Original runtime never changes owner.
 * Host queue callbacks enqueue, never execute inline. writeResult arms and copies
 * in one owner call. freeTarget must return only after worker runtime cleanup. */
final class ParamsUpdateJob {
    static final class Descriptor {
        final String metadata;final int length;final long bytes;final boolean unchanged;
        Descriptor(String metadata,int length,long bytes,boolean unchanged){
            if(length<0||length>4194304||bytes<0||bytes>NativeJobBudget.MAX_BYTES||!unchanged&&(metadata==null||metadata.length()>131072||bytes==0))throw new IllegalArgumentException("Params descriptor");
            this.metadata=metadata;this.length=length;this.bytes=bytes;this.unchanged=unchanged;
        }
    }
    static final class Result {
        final String text;final int outputs,capacity,checkpoints;
        Result(String text,int outputs,int capacity,int checkpoints){
            if(text==null||text.length()>131072||outputs<1||outputs>32||capacity<16||capacity>4194304||(capacity&(capacity-1))!=0||checkpoints<0||checkpoints>16385||(long)outputs*capacity*8>268435456L)throw new IllegalArgumentException("Params result bounds");
            this.text=text;this.outputs=outputs;this.capacity=capacity;this.checkpoints=checkpoints;
        }
    }
    static final class Record {
        final int index;final String text;
        Record(int index,String text){if(index<0||index>4194304||index%256!=0||text==null||text.length()>131072)throw new IllegalArgumentException("Params checkpoint bounds");this.index=index;this.text=text;}
    }
    static final class Receipt {
        final String status;final long registration;
        Receipt(String status,long registration){if(!java.util.Arrays.asList("active","failed","aborted","committed","unchanged","unknown").contains(status)||registration<1||registration>9007199254740991L)throw new IllegalArgumentException("Params receipt");this.status=status;this.registration=registration;}
        boolean published(){return status.equals("committed")||status.equals("unchanged");}
    }
    interface Host {
        void requireOwner();long currentHandle();long currentRevision();boolean closed();boolean current(ParamsUpdateJob job);
        boolean post(Runnable task);boolean postDelayed(Runnable task,long millis);
        long begin(long handle,String id,String params,long revision,long registration)throws Exception;
        Descriptor admit(long handle,long ticket,long revision)throws Exception;
        void checkSource(long handle,long ticket,long revision)throws Exception;
        byte[] readSource(long handle,long ticket,int slot,int offset,int count)throws Exception;
        long createTarget()throws Exception;
        void initializeTarget(long handle,String metadata)throws Exception;
        void writeTarget(long handle,int slot,int offset,byte[] bytes)throws Exception;
        void startTarget(long handle)throws Exception;
        boolean stepTarget(long handle,int bars)throws Exception;
        Result result(long handle)throws Exception;
        byte[] readResult(long handle,long registration,int slot,int offset,int count)throws Exception;
        Record checkpoint(long handle,int ordinal)throws Exception;
        void freeTarget(long handle);
        void receive(long handle,long ticket,String result,long revision)throws Exception;
        void writeResult(long handle,long ticket,int slot,int offset,byte[] bytes,long revision)throws Exception;
        void importCheckpoint(long handle,long ticket,Record record,long revision)throws Exception;
        boolean validate(long handle,long ticket,int values,long revision)throws Exception;
        void prepare(long handle,long ticket,long revision)throws Exception;
        Receipt publish(long handle,long ticket,long revision)throws Exception;
        Receipt status(long handle,long registration)throws Exception;
        Receipt abort(long handle,long registration)throws Exception;
        void releaseReservation(ParamsUpdateJob job);void notifyObservers();
        void onProgress(String phase,long done,long total);
        void onComplete(String status,String commitOutcome,String cleanupState,Throwable error,long copiedBytes,long logicalBytes,int callbackErrors);
        void onCallbackError(Throwable error);
    }
    private Host host;private String id,params;private final long source,revision,registration,started=System.nanoTime(),timeoutNanos;private final int bars;
    private NativeJobBudget.Lease budget;private Descriptor descriptor;private Thread worker;
    private volatile String stopped;private volatile Throwable failure;private volatile boolean terminal,committed,pending;
    private boolean startedOnce,beginAttempted,beginning,releasing,publishing,sourceReleased,reservationReleased,sourceFreeAttempted,sourceFreed;private volatile boolean publicationUnknown;private volatile String outcome="notCommitted";
    private volatile boolean targetCleanupUnknown;private long unresolvedTarget,ticket=-1,copiedBytes,logicalBytes;private int callbackErrors;
    private String progressPhase;private long progressDone,progressTotal;private boolean progressQueued;
    ParamsUpdateJob(Host host,String id,String params,long registration,long timeoutMillis,int bars){
        host.requireOwner();if(id==null||id.length()>128||params==null||params.length()>131072||registration<1||registration>9007199254740991L||timeoutMillis<1||timeoutMillis>600000||bars<1||bars>16384)throw new IllegalArgumentException("Params arguments");
        this.host=host;this.id=id;this.params=params;this.registration=registration;this.timeoutNanos=timeoutMillis*1000000L;this.bars=bars;source=host.currentHandle();revision=host.currentRevision();if(source==0||host.closed()||revision<0||revision>9007199254740991L)throw new IllegalStateException("Params source unavailable");
    }
    void enqueueInitial(){host.requireOwner();try{if(!host.post(this::start))throw new IllegalStateException("Params owner queue unavailable");}catch(Throwable error){if(!startedOnce){terminal=true;releaseReservation();clear();}throw error;}}
    synchronized void cancel(){if(terminal||committed)return;if(stopped==null)stopped="cancelled";if(!post(this::cleanupOnOwner))pending=true;}
    void closeOnOwner(){if(terminal||committed)return;host.requireOwner();stop("closed",null);cleanupOnOwner();}
    boolean committed(){return committed;}
    boolean pendingOwnerCleanup(){return pending;}
    boolean publicationUnknown(){return publicationUnknown;}
    String commitOutcome(){return outcome;}
    void sourceFreeStartedOnOwner(){if(terminal)return;host.requireOwner();sourceFreeAttempted=true;}
    void sourceFreedOnOwner(){if(terminal)return;host.requireOwner();sourceFreeAttempted=true;sourceFreed=true;sourceReleased=true;cleanupOnOwner();}
    void resumeOwnerCleanup(){if(terminal||!pending)return;host.requireOwner();cleanupOnOwner();}
    private synchronized void stop(String status,Throwable error){if(terminal||committed)return;if(stopped==null)stopped=status;if(failure==null)failure=error;}
    private void fail(Throwable error){stop(error instanceof Stop?((Stop)error).status:"failed",error);}
    private synchronized void check(){if(stopped==null&&!committed&&System.nanoTime()-started>=timeoutNanos)stopped="timedOut";if(stopped!=null&&!committed)throw new Stop(stopped);}
    private void ownerCheck(){if(terminal)throw new Stop("closed");host.requireOwner();check();if(host.closed()||host.currentHandle()!=source||host.currentRevision()!=revision||!host.current(this))throw new Stop(host.closed()?"closed":"stale");}
    private boolean post(Runnable task){try{return host!=null&&host.post(task);}catch(Throwable error){fail(error);return false;}}
    private boolean later(Runnable task){try{return host!=null&&host.postDelayed(task,1);}catch(Throwable error){fail(error);return false;}}
    void start(){if(terminal||startedOnce)return;host.requireOwner();startedOnce=true;try{budget=NativeJobBudget.reserve();ownerCheck();beginAttempted=true;beginning=true;try{ticket=host.begin(source,id,params,revision,registration);if(ticket<1||ticket>9007199254740991L)throw new IllegalStateException("Params ticket");}finally{beginning=false;}ownerCheck();id=null;params=null;if(!post(this::admitOnOwner))throw new IllegalStateException("Params admission queue unavailable");}catch(Throwable error){fail(error);cleanupOnOwner();}}
    private void admitOnOwner(){if(terminal||worker!=null)return;try{ownerCheck();Descriptor next=host.admit(source,ticket,revision);ownerCheck();if(next==null){if(!post(this::admitOnOwner))throw new IllegalStateException("Params admission queue unavailable");return;}descriptor=next;if(next.unchanged){finishOnOwner();return;}NativeJobBudget.admit(budget,next.bytes);logicalBytes=next.bytes;worker=new Thread(this::runWorker,"BaroChart indicator parameters");worker.start();}catch(Throwable error){fail(error);cleanupOnOwner();}}
    private interface OwnerCall<T>{T call()throws Exception;}
    private static final class Reply<T>{final T value;final Throwable error;Reply(T value,Throwable error){this.value=value;this.error=error;}}
    private <T>T onOwner(OwnerCall<T> operation)throws Exception{
        final ArrayBlockingQueue<Reply<T>> queue=new ArrayBlockingQueue<>(1);
        if(!post(()->{try{ownerCheck();T value=operation.call();ownerCheck();queue.offer(new Reply<T>(value,null));}catch(Throwable error){queue.offer(new Reply<T>(null,error));}}))throw new IllegalStateException("Params owner queue unavailable");
        for(;;){check();Reply<T> reply=queue.poll(20,TimeUnit.MILLISECONDS);if(reply==null)continue;if(reply.error instanceof Exception)throw (Exception)reply.error;if(reply.error!=null)throw new IllegalStateException("Params owner operation",reply.error);check();return reply.value;}
    }
    private static void bytes(byte[] value,int count){if(value==null||value.length!=count*8)throw new IllegalStateException("Params transfer length");}
    private void runWorker(){long target=0;try{
        check();target=host.createTarget();if(target==0)throw new IllegalStateException("Params target missing");check();host.initializeTarget(target,descriptor.metadata);
        for(int slot=0;slot<6;slot++)for(int offset=0;offset<descriptor.length;){check();final int field=slot,at=offset,count=Math.min(16384,descriptor.length-offset);byte[] chunk=onOwner(()->{host.checkSource(source,ticket,revision);ownerCheck();byte[] value=host.readSource(source,ticket,field,at,count);bytes(value,count);return value;});check();host.writeTarget(target,slot,offset,chunk);offset+=count;copiedBytes+=chunk.length;report("capture",copiedBytes,descriptor.length*48L);}
        check();host.startTarget(target);while(!host.stepTarget(target,bars)){check();}check();final Result result=host.result(target);onOwner(()->{host.receive(source,ticket,result.text,revision);return true;});
        for(int slot=0;slot<result.outputs;slot++)for(int offset=0;offset<result.capacity;){check();final int field=slot,at=offset,count=Math.min(16384,result.capacity-offset);final byte[] chunk=host.readResult(target,registration,slot,offset,count);bytes(chunk,count);onOwner(()->{host.writeResult(source,ticket,field,at,chunk,revision);return true;});offset+=count;copiedBytes+=chunk.length;report("result-copy",(long)slot*result.capacity+offset,(long)result.outputs*result.capacity);}
        for(int i=0;i<result.checkpoints;i++){check();final Record record=host.checkpoint(target,i);if(record.index!=i*256)throw new IllegalStateException("Params checkpoint order");onOwner(()->{host.importCheckpoint(source,ticket,record,revision);return true;});}
        while(!onOwner(()->host.validate(source,ticket,16384,revision))){check();}check();
    }catch(Throwable error){fail(error);}finally{if(target!=0){try{host.freeTarget(target);}catch(Throwable error){targetCleanupUnknown=true;unresolvedTarget=target;fail(error);}}if(!post(this::finishOnOwner))pending=true;}}
    private Receipt bound(Receipt value){if(value==null||value.registration!=registration)throw new IllegalStateException("Params receipt binding");return value;}
    private void published(Receipt value){outcome=value.status;committed=true;sourceReleased=true;publicationUnknown=false;stopped=null;failure=null;}
    private void finishOnOwner(){if(terminal)return;host.requireOwner();if(worker!=null&&worker.isAlive()){if(!later(this::finishOnOwner))pending=true;return;}if(targetCleanupUnknown){pending=true;return;}
        try{ownerCheck();host.checkSource(source,ticket,revision);ownerCheck();host.prepare(source,ticket,revision);ownerCheck();
            synchronized(this){ownerCheck();publishing=true;try{Receipt value=bound(host.publish(source,ticket,revision));if(!value.published())throw new IllegalStateException("Params publish receipt");published(value);}catch(Throwable error){publicationUnknown=true;outcome="unknown";failure=error;try{Receipt value=bound(host.status(source,registration));if(value.published())published(value);else if(!value.status.equals("unknown")){publicationUnknown=false;outcome="notCommitted";fail(error);}}catch(Throwable lookup){/* Keep original failure and reservation until status recovery. */}}finally{publishing=false;}}
        }catch(Throwable error){fail(error);}cleanupOnOwner();
    }
    private void cleanupOnOwner(){if(terminal)return;host.requireOwner();if(beginning||publishing||releasing)return;if(worker!=null&&worker.isAlive())return;if(targetCleanupUnknown){pending=true;return;}
        if(sourceFreeAttempted&&!sourceFreed){pending=true;return;}
        if(publicationUnknown&&!sourceFreed){try{Receipt value=bound(host.status(source,registration));if(value.published())published(value);else if(!value.status.equals("unknown")){publicationUnknown=false;outcome="notCommitted";}}catch(Throwable error){pending=true;return;}if(publicationUnknown){pending=true;return;}}
        if(!sourceReleased){if(!beginAttempted)sourceReleased=true;else if(sourceFreed)sourceReleased=true;else{releasing=true;try{Receipt value=bound(host.abort(source,registration));if(value.published())published(value);else if(value.status.equals("aborted")||value.status.equals("failed"))sourceReleased=true;else{pending=true;return;}}catch(Throwable error){fail(error);pending=true;return;}finally{releasing=false;}}}
        if(!sourceReleased){pending=true;return;}terminal=true;pending=false;releaseReservation();if(committed&&outcome.equals("committed")&&!host.closed()){try{host.notifyObservers();}catch(Throwable error){callbackError(error);}}
        try{host.onComplete(publicationUnknown?"indeterminate":committed?"success":stopped==null?"failed":stopped,outcome,"complete",committed?null:failure,copiedBytes,logicalBytes,callbackErrors);}catch(Throwable error){callbackError(error);}finally{clear();}
    }
    private void releaseReservation(){NativeJobBudget.release(budget);budget=null;if(!reservationReleased){reservationReleased=true;host.releaseReservation(this);}}
    private void clear(){descriptor=null;id=null;params=null;worker=null;progressPhase=null;host=null;}
    private void report(String phase,long done,long total){synchronized(this){if(terminal||stopped!=null)return;progressPhase=phase;progressDone=done;progressTotal=total;if(progressQueued)return;progressQueued=true;}if(!post(this::deliverProgress)){synchronized(this){progressQueued=false;progressPhase=null;}}}
    private void deliverProgress(){String phase;long done,total;synchronized(this){progressQueued=false;phase=progressPhase;done=progressDone;total=progressTotal;progressPhase=null;if(terminal||stopped!=null)return;}if(phase!=null)try{host.onProgress(phase,done,total);}catch(Throwable error){callbackError(error);}}
    private void callbackError(Throwable error){if(callbackErrors<32)callbackErrors++;try{if(host!=null)host.onCallbackError(error);}catch(Throwable ignored){/* Diagnostics cannot alter publication. */}}
    private static final class Stop extends IllegalStateException{private static final long serialVersionUID=1L;final String status;Stop(String status){super("Params "+status);this.status=status;}}
}
