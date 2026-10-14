package dev.aster.charts;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Package-private production ownership machine. No Android/JNI/JSON dependency.
 * Host implementations must make publish/releaseReservation callback-free and
 * non-throwing after mutation. post/postDelayed enqueue (never run inline), and
 * true means eventual owner delivery. Host owns a preallocated Begin registration
 * identity: releaseSource must abort it even if no ticket was received (ticket -1).
 * createTarget must return an owned handle or clean its allocation before throwing. Source JNI is
 * owner-only; target JNI is worker-only until the worker has exited. */
final class WorkspaceRestoreJob {
    static final long MAX_BYTES=805306368L;
    private static long nextRegistration;
    static synchronized long nextRegistration(){if(nextRegistration>=9007199254740991L)throw new IllegalStateException("Workspace registration exhausted");return ++nextRegistration;}
    static final class Descriptor {
        final long ticket,logicalBytes;final String metadata;final int length;
        Descriptor(long ticket,String metadata,int length,long logicalBytes){if(ticket<1||ticket>9007199254740991L||metadata==null||metadata.length()>8388608||length<0||length>4194304||logicalBytes<1||logicalBytes>MAX_BYTES)throw new IllegalArgumentException("Workspace descriptor limits");this.ticket=ticket;this.metadata=metadata;this.length=length;this.logicalBytes=logicalBytes;}
    }
    static final class Admission {final long done;final Descriptor descriptor;Admission(long done,Descriptor descriptor){if(done<0)throw new IllegalArgumentException("Workspace admission progress");this.done=done;this.descriptor=descriptor;}}
    static final class Progress {final String phase;final long done,total;final boolean complete;Progress(String phase,long done,long total,boolean complete){if(phase==null||done<0||total<0||done>total)throw new IllegalArgumentException("Workspace progress");this.phase=phase;this.done=done;this.total=total;this.complete=complete;}}
    static final class Metrics {final long elapsedNanos,copiedBytes,logicalBytes;final int callbackErrors;Metrics(long elapsedNanos,long copiedBytes,long logicalBytes,int callbackErrors){this.elapsedNanos=elapsedNanos;this.copiedBytes=copiedBytes;this.logicalBytes=logicalBytes;this.callbackErrors=callbackErrors;}}
    interface Host {
        void requireOwner();long currentHandle();long currentRevision();boolean closed();boolean current(WorkspaceRestoreJob job);
        boolean post(Runnable action);boolean postDelayed(Runnable action,long delayMillis);
        long beginSource(long handle,String document,String binding,long revision) throws Exception;
        Admission admitSource(long handle,long ticket,int records,long revision) throws Exception;
        void checkSource(long handle,long ticket,long revision) throws Exception;
        byte[] readSource(long handle,long ticket,int slot,int offset,int count) throws Exception;
        void finishSource(long handle,long ticket,long revision) throws Exception;
        void releaseSource(long handle,long ticket) throws Exception;
        long createTarget(String metadata) throws Exception;
        void writeTarget(long handle,int slot,int offset,byte[] bytes) throws Exception;
        void startTarget(long handle) throws Exception;
        Progress stepTarget(long handle,int bars) throws Exception;
        void finishTarget(long handle) throws Exception;
        void free(long handle);
        // Recheck engine source/revision/closed/current-job and swap with no callback.
        void publish(WorkspaceRestoreJob job,long source,long target,long revision);
        void releaseReservation(WorkspaceRestoreJob job);
        void notifyObservers();void onProgress(String phase,long done,long total);
        void onComplete(String status,Throwable error,Metrics metrics);void onCallbackError(Throwable error);
    }
    private NativeJobBudget.Lease budgetLease;private Host host;private String document,binding;private final long source,revision,started=System.nanoTime(),timeoutNanos;private final int bars;
    private volatile String stopped;private volatile Throwable failure;private volatile boolean committed,terminal;private boolean sourceReleased,slotReserved,bytesReserved,reservationReleased,startCalled,beginInProgress,beginAttempted,admitting,handoffInProgress,sourceReleaseInProgress;private volatile boolean ownerCleanupPending;private long ticket=-1,logicalBytes,copiedBytes,pendingTarget;private int callbackErrors;private Descriptor descriptor;private Thread worker;private Progress latestProgress;private boolean progressQueued;
    WorkspaceRestoreJob(Host host,String document,String binding,long timeoutMillis,int bars){host.requireOwner();if(document==null||document.length()>2097152||binding==null||binding.length()>32768||timeoutMillis<1||timeoutMillis>600000||bars<1||bars>16384)throw new IllegalArgumentException("Workspace arguments/limits");this.host=host;this.document=document;this.binding=binding;this.timeoutNanos=timeoutMillis*1000000L;this.bars=bars;source=host.currentHandle();revision=host.currentRevision();if(source==0||revision<0||revision>9007199254740991L||host.closed())throw new IllegalStateException("Workspace source closed/revision limit");}
    void enqueueInitial(){host.requireOwner();try{if(!host.post(this::start))throw new IllegalStateException("Workspace owner queue unavailable");}catch(Throwable error){try{releaseReservation();}finally{discardBeforeStart();}throw error;}}
    // Initial enqueue failed before the public method returned a cancellation handle.
    // No source was entered and no completion callback is owed for a throwing call.
    synchronized void discardBeforeStart(){if(terminal)return;host.requireOwner();if(startCalled)throw new IllegalStateException("Workspace already started");terminal=true;sourceReleased=true;reservationReleased=true;document=null;binding=null;descriptor=null;worker=null;latestProgress=null;host=null;}
    boolean committed(){return committed;}
    private static synchronized void reserveSlot(WorkspaceRestoreJob job){if(job.slotReserved)throw new IllegalStateException("Workspace already reserved");job.budgetLease=NativeJobBudget.reserve();job.slotReserved=true;}
    private static synchronized void reserveBytes(WorkspaceRestoreJob job,long bytes){if(job.bytesReserved)throw new IllegalStateException("Workspace bytes already reserved");NativeJobBudget.admit(job.budgetLease,bytes);job.logicalBytes=bytes;job.bytesReserved=true;}
    private static synchronized void releaseBudget(WorkspaceRestoreJob job){NativeJobBudget.release(job.budgetLease);job.budgetLease=null;job.bytesReserved=false;job.slotReserved=false;}
    static synchronized long[] budgetForTest(){return NativeJobBudget.snapshot();}
    synchronized void cancel(){if(committed||terminal||stopped!=null)return;stopped="cancelled";if(!postOwner(this::stopOnOwner)&&worker==null&&!beginInProgress)deferOwnerCleanup();}
    void closeOnOwner(){if(terminal||committed)return;host.requireOwner();stop("closed",null);stopOnOwner();}
    private synchronized void stop(String status,Throwable error){if(committed||terminal)return;if(stopped==null)stopped=status;if(failure==null)failure=error;}
    private synchronized void check(){if(!committed&&stopped==null&&System.nanoTime()-started>=timeoutNanos)stopped="timedOut";if(stopped!=null)throw new Stop(stopped);}
    private void ownerCheck(){if(terminal)throw new Stop("closed");host.requireOwner();check();if(host.closed()||host.currentHandle()!=source||host.currentRevision()!=revision||!host.current(this))throw new Stop(host.closed()?"closed":"stale");}
    private boolean releaseSource(){if(sourceReleased)return true;if(host==null||beginInProgress||sourceReleaseInProgress)return false;host.requireOwner();if(!beginAttempted||host.currentHandle()!=source){sourceReleased=true;return true;}sourceReleaseInProgress=true;try{host.releaseSource(source,ticket);sourceReleased=true;return true;}catch(Throwable error){fail(error);ownerCleanupPending=true;return false;}finally{sourceReleaseInProgress=false;}}
    void start(){if(terminal||startCalled)return;host.requireOwner();startCalled=true;try{reserveSlot(this);ownerCheck();beginAttempted=true;beginInProgress=true;try{long received=host.beginSource(source,document,binding,revision);if(received<1||received>9007199254740991L)throw new IllegalStateException("Workspace source ticket");ticket=received;}finally{beginInProgress=false;}ownerCheck();document=null;binding=null;scheduleAdmission();}catch(Throwable error){fail(error);complete();}}
    private boolean postOwner(Runnable action){try{return host!=null&&host.post(action);}catch(Throwable error){fail(error);return false;}}
    private boolean postDelayedOwner(Runnable action,long delay){try{return host!=null&&host.postDelayed(action,delay);}catch(Throwable error){fail(error);return false;}}
    private void scheduleAdmission(){if(!postOwner(this::admitOnOwner)){fail(new IllegalStateException("Workspace owner queue unavailable"));releaseSource();complete();}}
    private void admitOnOwner(){if(terminal||worker!=null||admitting)return;admitting=true;try{ownerCheck();Admission a=host.admitSource(source,ticket,8,revision);ownerCheck();progress("source-admission",a.done,0);ownerCheck();if(a.descriptor==null){scheduleAdmission();return;}if(a.descriptor.ticket!=ticket)throw new IllegalStateException("Workspace admission ticket");descriptor=a.descriptor;reserveBytes(this,descriptor.logicalBytes);worker=new Thread(this::runWorker,"Aster workspace restore");worker.start();}catch(Throwable error){fail(error);releaseSource();complete();}finally{admitting=false;}}
    private interface OwnerCall<T>{T call() throws Exception;}
    private static final class Reply<T>{final T value;final Throwable error;Reply(T value,Throwable error){this.value=value;this.error=error;}}
    private <T>T onOwner(OwnerCall<T> action) throws Exception {final ArrayBlockingQueue<Reply<T>> reply=new ArrayBlockingQueue<>(1);if(!postOwner(()->{try{ownerCheck();reply.offer(new Reply<T>(action.call(),null));}catch(Throwable error){reply.offer(new Reply<T>(null,error));}}))throw new IllegalStateException("Workspace owner queue unavailable");while(true){check();Reply<T> r=reply.poll(20,TimeUnit.MILLISECONDS);if(r==null)continue;if(r.error instanceof Exception)throw (Exception)r.error;if(r.error!=null)throw new IllegalStateException("Workspace owner operation failed",r.error);check();return r.value;}}
    private void runWorker(){long target=0;boolean handedOff=false;try{check();target=host.createTarget(descriptor.metadata);if(target==0)throw new IllegalStateException("Workspace missing target");for(int slot=0;slot<6;slot++)for(int offset=0;offset<descriptor.length;){check();final int field=slot,at=offset,count=Math.min(262144,descriptor.length-offset);byte[] chunk=onOwner(()->{host.checkSource(source,ticket,revision);ownerCheck();byte[] bytes=host.readSource(source,ticket,field,at,count);ownerCheck();if(bytes==null||bytes.length!=count*8)throw new IllegalStateException("Workspace copy length");return bytes;});check();host.writeTarget(target,slot,offset,chunk);copiedBytes+=chunk.length;offset+=count;report("capture",copiedBytes,descriptor.length*48L);}
        check();host.startTarget(target);while(true){check();Progress p=host.stepTarget(target,bars);report(p.phase,p.done,p.total);if(p.complete)break;}check();host.finishTarget(target);check();final long ready=target;target=0;synchronized(this){pendingTarget=ready;}handedOff=postOwner(()->handoff(ready));if(!handedOff){synchronized(this){pendingTarget=0;}target=ready;throw new IllegalStateException("Workspace handoff queue unavailable");}
      }catch(Throwable error){fail(error);}finally{if(target!=0){synchronized(this){pendingTarget=0;}long doomed=target;target=0;try{host.free(doomed);}catch(Throwable error){fail(error);}}if(!handedOff&&!postOwner(this::complete)){deferOwnerCleanup();}}}
    private void handoff(long target){synchronized(this){if(terminal||pendingTarget!=target)return;}host.requireOwner();if(worker!=null&&worker.isAlive()){final long waiting=target;if(!postDelayedOwner(()->handoff(waiting),1)){synchronized(this){pendingTarget=0;}try{host.free(target);}finally{fail(new IllegalStateException("Workspace handoff queue unavailable"));releaseSource();complete();}}return;}
      handoffInProgress=true;try{ownerCheck();host.checkSource(source,ticket,revision);ownerCheck();host.finishSource(source,ticket,revision);sourceReleased=true;
        synchronized(this){ownerCheck();host.publish(this,source,target,revision);committed=true;pendingTarget=0;target=0;}
        // Ownership/budget are released before any retired cleanup or observer.
        releaseReservation();
        try{host.free(source);}catch(Throwable error){callbackError(error);}try{host.notifyObservers();}catch(Throwable error){callbackError(error);}complete();
      }catch(Throwable error){fail(error);}finally{if(target!=0){synchronized(this){pendingTarget=0;}long doomed=target;target=0;try{host.free(doomed);}catch(Throwable error){fail(error);}}handoffInProgress=false;if(!terminal){releaseSource();complete();}}}
    private void releaseReservation(){releaseBudget(this);if(!reservationReleased){reservationReleased=true;host.releaseReservation(this);}}
    long[] retainedForTest(){return new long[]{host==null?0:1,document==null?0:document.length(),binding==null?0:binding.length(),descriptor==null?0:1,worker==null?0:1,pendingTarget};}
    private void stopOnOwner(){if(terminal||committed)return;host.requireOwner();if(beginInProgress||handoffInProgress||sourceReleaseInProgress)return;ownerCleanupPending=false;releaseSource();if(worker==null||!worker.isAlive()){long doomed;synchronized(this){doomed=pendingTarget;pendingTarget=0;}if(doomed!=0)try{host.free(doomed);}catch(Throwable error){fail(error);}complete();}}
    boolean pendingOwnerCleanup(){return ownerCleanupPending;}
    String pendingOwnerFailure(){return ownerCleanupPending?stopped:null;}
    void resumeOwnerCleanup(){if(!ownerCleanupPending||terminal||sourceReleaseInProgress)return;host.requireOwner();if(worker!=null&&worker.isAlive())return;ownerCleanupPending=false;complete();}
    private synchronized void deferOwnerCleanup(){if(terminal)return;descriptor=null;document=null;binding=null;worker=null;latestProgress=null;ownerCleanupPending=true;}

    private void fail(Throwable error){stop(error instanceof Stop?((Stop)error).status:"failed",error);}
    private void report(String phase,long done,long total){synchronized(this){if(terminal||stopped!=null)return;latestProgress=new Progress(phase,done,total,false);if(progressQueued)return;progressQueued=true;}if(!postOwner(this::deliverProgress)){synchronized(this){progressQueued=false;latestProgress=null;}}}
    private void deliverProgress(){Progress value;synchronized(this){progressQueued=false;value=latestProgress;latestProgress=null;if(terminal||stopped!=null)return;}if(value!=null)progress(value.phase,value.done,value.total);}
    private void progress(String phase,long done,long total){try{host.onProgress(phase,done,total);}catch(Throwable error){callbackError(error);}}
    private void callbackError(Throwable error){if(callbackErrors<32)callbackErrors++;try{Host currentHost=host;if(currentHost!=null)currentHost.onCallbackError(error);}catch(Throwable ignored){/* Terminal ownership must not be changed by diagnostics. */}}
    private void complete(){if(terminal)return;host.requireOwner();if(ownerCleanupPending&&!sourceReleased||!releaseSource()){deferOwnerCleanup();return;}synchronized(this){if(terminal)return;terminal=true;ownerCleanupPending=false;latestProgress=null;progressQueued=false;}releaseReservation();String status=committed?"success":stopped==null?"failed":stopped;Throwable error=committed?null:failure;descriptor=null;document=null;binding=null;worker=null;try{host.onComplete(status,error,new Metrics(System.nanoTime()-started,copiedBytes,logicalBytes,callbackErrors));}catch(Throwable callback){callbackError(callback);}finally{host=null;}}
    private static final class Stop extends IllegalStateException {private static final long serialVersionUID=1L;final String status;Stop(String status){super("Workspace "+status);this.status=status;}}
}
