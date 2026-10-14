package dev.aster.charts;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.Arrays;

/** Independent fake transport; no Android, JSON, JNI or actual native allocator. */
public final class ParamsUpdateJobHarness {
    static int checks,scenarios;
    static void check(boolean condition,String label){checks++;if(!condition)throw new AssertionError(label);}
    interface Case{void run()throws Exception;}
    static void test(String name,Case run)throws Exception{if(!Arrays.equals(NativeJobBudget.snapshot(),new long[]{0,0}))throw new AssertionError("entry budget");run.run();check(Arrays.equals(NativeJobBudget.snapshot(),new long[]{0,0}),"exit budget");scenarios++;System.out.println("PASS "+name);}
    static final class Fake implements ParamsUpdateJob.Host {
        final Thread owner=Thread.currentThread();final ArrayBlockingQueue<Runnable> queue=new ArrayBlockingQueue<>(128);
        ParamsUpdateJob job,active;long handle=1,revision=3;boolean closed,published,unknownStatus,freeThrows,noop,rejectPost,postThrows,postThenThrows;String failAt,cancelAt,status,outcome,cleanup;int frees,aborts,notifies,completions,created,sourceCalls,writes,callbacks,expectedOtherJobs;Throwable testFailure;Runnable onBegin,onNotify;
        void make(){job=new ParamsUpdateJob(this,"ema","{}",7,10000,31);active=job;}
        void start(){make();job.enqueueInitial();}
        void pump()throws Exception{long until=System.nanoTime()+10000000000L;while(completions==0&&!job.pendingOwnerCleanup()){Runnable r=queue.poll();if(r!=null)r.run();else Thread.sleep(1);if(System.nanoTime()>until)throw new AssertionError("watchdog");}drain();if(testFailure!=null)throw new AssertionError("callback assertion",testFailure);}
        void drain(){Runnable r;while((r=queue.poll())!=null)r.run();}
        void phase(String value){if(value.equals(cancelAt))job.cancel();if(value.equals("step")&&"ownerQueue".equals(failAt))rejectPost=true;}
        void source(String phase)throws Exception{requireOwner();sourceCalls++;phase(phase);if(phase.equals(failAt))throw new Exception(phase);}
        void worker(){if(Thread.currentThread()==owner)throw new AssertionError("worker affinity");}
        public void requireOwner(){if(Thread.currentThread()!=owner)throw new AssertionError("owner affinity");}
        public long currentHandle(){return handle;}public long currentRevision(){return revision;}public boolean closed(){return closed;}public boolean current(ParamsUpdateJob j){return active==j;}
        public boolean post(Runnable r){if(postThrows)throw new IllegalStateException("post");boolean accepted=!rejectPost&&queue.offer(r);if(postThenThrows)throw new IllegalStateException("post after enqueue");return accepted;}public boolean postDelayed(Runnable r,long delay){return post(r);}
        public long begin(long h,String id,String params,long revision,long registration)throws Exception{source("begin");if(onBegin!=null)onBegin.run();return 9;}
        public ParamsUpdateJob.Descriptor admit(long h,long t,long r)throws Exception{source("admit");return new ParamsUpdateJob.Descriptor("metadata",1,100,noop);}
        public void checkSource(long h,long t,long r)throws Exception{source("check");}
        public byte[] readSource(long h,long t,int s,int o,int n)throws Exception{source("read");return new byte[n*8];}
        public long createTarget()throws Exception{worker();phase("create");created++;if("create".equals(failAt))throw new Exception("create");return 2;}
        public void initializeTarget(long h,String text)throws Exception{worker();phase("initialize");if("initialize".equals(failAt))throw new Exception("initialize");}
        public void writeTarget(long h,int s,int o,byte[] b)throws Exception{worker();phase("write");if("write".equals(failAt))throw new Exception("write");}
        public void startTarget(long h)throws Exception{worker();phase("start");if("start".equals(failAt))throw new Exception("start");}
        public boolean stepTarget(long h,int n)throws Exception{worker();phase("step");if("step".equals(failAt))throw new Exception("step");return true;}
        public ParamsUpdateJob.Result result(long h)throws Exception{worker();phase("result");if("result".equals(failAt))throw new Exception("result");return new ParamsUpdateJob.Result("result",1,16,1);}
        public byte[] readResult(long h,long reg,int s,int o,int n)throws Exception{worker();phase("readResult");if("readResult".equals(failAt))throw new Exception("readResult");return new byte[n*8];}
        public ParamsUpdateJob.Record checkpoint(long h,int ordinal)throws Exception{worker();phase("checkpoint");if("checkpoint".equals(failAt))throw new Exception("checkpoint");return new ParamsUpdateJob.Record(0,"{}");}
        public void freeTarget(long h){worker();frees++;if(freeThrows)throw new IllegalStateException("free uncertain");}
        public void receive(long h,long t,String text,long r)throws Exception{source("receive");}
        public void writeResult(long h,long t,int s,int o,byte[] bytes,long r)throws Exception{source("writeResult");writes++;}
        public void importCheckpoint(long h,long t,ParamsUpdateJob.Record rec,long r)throws Exception{source("import");}
        public boolean validate(long h,long t,int count,long r)throws Exception{source("validate");return true;}
        public void prepare(long h,long t,long r)throws Exception{source("prepare");if(!noop&&frees!=1)throw new AssertionError("worker cleanup before prepare");}
        public ParamsUpdateJob.Receipt publish(long h,long t,long r)throws Exception{source("publishBefore");published=true;if("publishAfter".equals(failAt))throw new Exception("lost publish response");return receipt(noop?"unchanged":"committed");}
        ParamsUpdateJob.Receipt receipt(String value){return new ParamsUpdateJob.Receipt(value,7);}
        public ParamsUpdateJob.Receipt status(long h,long reg)throws Exception{requireOwner();if(unknownStatus)throw new Exception("status unavailable");return receipt(published?"committed":"active");}
        public ParamsUpdateJob.Receipt abort(long h,long reg)throws Exception{source("abort");aborts++;return receipt(published?"committed":"aborted");}
        public void releaseReservation(ParamsUpdateJob j){requireOwner();if(active==j)active=null;}
        public void notifyObservers(){requireOwner();notifies++;if(onNotify!=null)onNotify.run();}
        public void onProgress(String p,long done,long total){requireOwner();}
        public void onComplete(String s,String o,String c,Throwable error,long copied,long bytes,int callbackErrors){requireOwner();completions++;status=s;outcome=o;cleanup=c;check(active==null,"busy released");check(Arrays.equals(NativeJobBudget.snapshot(),new long[]{expectedOtherJobs,0}),"budget before callback");}
        public void onCallbackError(Throwable error){callbacks++;if(error instanceof AssertionError)testFailure=error;}
    }
    public static void main(String[] args)throws Exception{
        if(args.length>0&&args[0].equals("uncertain-free")){Fake f=new Fake();f.freeThrows=true;f.start();f.pump();check(f.job.pendingOwnerCleanup(),"pending");check(f.completions==0&&f.notifies==0,"no terminal");check(NativeJobBudget.snapshot()[0]==1&&NativeJobBudget.snapshot()[1]==100,"reservation held");check(f.frees==1,"no retry free");System.out.println("UNCERTAIN_FREE checks="+checks);return;}
        test("success-entry-only",()->{Fake f=new Fake();f.start();f.pump();check(f.status.equals("success")&&f.outcome.equals("committed"),"success");check(f.handle==1&&f.frees==1&&f.notifies==1&&f.completions==1,"ownership");check(f.writes==1,"result copy");});
        test("unchanged-without-worker",()->{Fake f=new Fake();f.noop=true;f.start();f.pump();check(f.status.equals("success")&&f.outcome.equals("unchanged"),"unchanged");check(f.created==0&&f.frees==0&&f.notifies==0,"no work notification");});
        for(String phase:new String[]{"begin","admit","read","create","initialize","write","start","step","result","receive","readResult","writeResult","checkpoint","import","validate","prepare","publishBefore"})test("failure-"+phase.toLowerCase(java.util.Locale.ROOT),()->{Fake f=new Fake();f.failAt=phase;f.start();f.pump();check(f.status.equals("failed")&&f.outcome.equals("notCommitted"),"failed");check(f.notifies==0&&f.completions==1,"once");});
        for(String phase:new String[]{"begin","admit","read","create","initialize","write","start","step","result","receive","readResult","writeResult","checkpoint","import","validate","prepare"})test("cancel-"+phase.toLowerCase(java.util.Locale.ROOT),()->{Fake f=new Fake();f.cancelAt=phase;f.start();f.pump();check(f.status.equals("cancelled")&&f.outcome.equals("notCommitted"),"cancelled");check(f.notifies==0&&f.completions==1,"cancel once");});
        test("abort-reply-uncertain-recovery",()->{Fake f=new Fake();f.onBegin=()->f.job.cancel();f.failAt="abort";f.start();f.pump();check(f.completions==0&&f.job.pendingOwnerCleanup(),"abort pending");check(NativeJobBudget.snapshot()[0]==1,"abort reservation");f.failAt=null;f.job.resumeOwnerCleanup();f.drain();check(f.status.equals("cancelled")&&f.aborts==1,"abort recovered");});
        test("source-revision-changed-during-begin",()->{Fake f=new Fake();f.onBegin=()->f.revision++;f.start();f.pump();check(f.status.equals("stale")&&f.created==0&&f.aborts==1,"stale before worker");});
        test("lost-publish-response",()->{Fake f=new Fake();f.failAt="publishAfter";f.start();f.pump();check(f.status.equals("success")&&f.notifies==1,"recovered success");f.job.cancel();f.drain();check(f.completions==1&&f.notifies==1,"once");});
        test("unknown-receipt-recovery",()->{Fake f=new Fake();f.failAt="publishAfter";f.unknownStatus=true;f.start();f.pump();check(f.job.publicationUnknown()&&f.job.pendingOwnerCleanup(),"unknown pending");check(f.completions==0&&NativeJobBudget.snapshot()[0]==1,"reserved");f.job.cancel();f.drain();check(f.job.commitOutcome().equals("unknown"),"cancel preserves unknown");f.unknownStatus=false;f.job.resumeOwnerCleanup();f.drain();check(f.status.equals("success")&&f.notifies==1&&f.completions==1,"recovered once");});
        test("unknown-close-confirmed",()->{Fake f=new Fake();f.failAt="publishAfter";f.unknownStatus=true;f.start();f.pump();f.closed=true;f.job.closeOnOwner();f.job.sourceFreeStartedOnOwner();f.handle=0;f.job.sourceFreedOnOwner();f.drain();check(f.status.equals("indeterminate")&&f.outcome.equals("unknown"),"indeterminate");check(f.notifies==0&&f.completions==1,"no closed notify");});
        test("unknown-close-free-unconfirmed",()->{Fake f=new Fake();f.failAt="publishAfter";f.unknownStatus=true;f.start();f.pump();f.closed=true;f.job.sourceFreeStartedOnOwner();f.handle=0;f.job.resumeOwnerCleanup();check(f.completions==0&&NativeJobBudget.snapshot()[0]==1,"uncertain free held");f.job.sourceFreedOnOwner();check(f.status.equals("indeterminate")&&f.notifies==0,"confirmed cleanup");});
        test("observer-reentry-after-budget-release",()->{Fake f=new Fake();f.onNotify=()->{check(f.active==null&&NativeJobBudget.snapshot()[0]==0,"observer budget");f.job.cancel();throw new IllegalStateException("observer");};f.start();f.pump();check(f.status.equals("success")&&f.callbacks==1&&f.completions==1,"observer isolated");});
        test("cancel-during-begin",()->{Fake f=new Fake();f.onBegin=()->f.job.cancel();f.start();f.pump();check(f.status.equals("cancelled")&&f.aborts==1&&f.created==0,"registration aborted");});
        test("initial-post-rejection",()->{Fake f=new Fake();f.make();f.rejectPost=true;boolean threw=false;try{f.job.enqueueInitial();}catch(IllegalStateException expected){threw=true;}check(threw&&f.active==null&&f.completions==0&&f.sourceCalls==0,"initial failure");});
        test("owner-queue-recovery-after-worker-cleanup",()->{Fake f=new Fake();f.failAt="ownerQueue";f.start();f.pump();check(f.job.pendingOwnerCleanup()&&f.completions==0,"queue pending");f.rejectPost=false;long until=System.nanoTime()+2000000000L;while(f.completions==0){f.job.resumeOwnerCleanup();f.drain();Thread.sleep(1);if(System.nanoTime()>until)throw new AssertionError("cleanup watchdog");}check(f.frees==1&&f.aborts==1&&f.notifies==0,"cleanup once");});
        test("duplicate-start-once",()->{Fake f=new Fake();f.start();f.job.start();f.pump();check(f.created==1&&f.completions==1&&f.frees==1,"once start");});
        for(boolean queued:new boolean[]{false,true})test(queued?"initial-post-then-throw":"initial-post-throw",()->{Fake f=new Fake();f.make();f.postThrows=!queued;f.postThenThrows=queued;boolean threw=false;try{f.job.enqueueInitial();}catch(IllegalStateException expected){threw=true;}f.postThrows=false;f.postThenThrows=false;f.drain();check(threw&&f.active==null&&f.sourceCalls==0&&f.completions==0,"late start discarded");});
        test("closed-committed-recovery-no-notify",()->{Fake f=new Fake();f.failAt="publishAfter";f.unknownStatus=true;f.start();f.pump();f.closed=true;f.unknownStatus=false;f.job.resumeOwnerCleanup();check(f.status.equals("success")&&f.outcome.equals("committed")&&f.notifies==0,"closed committed");});
        test("shared-budget-rejects-third-owner",()->{NativeJobBudget.Lease a=NativeJobBudget.reserve(),b=NativeJobBudget.reserve();Fake f=new Fake();f.expectedOtherJobs=2;f.start();try{f.pump();check(f.status.equals("failed")&&f.created==0,"third rejected");}finally{NativeJobBudget.release(a);NativeJobBudget.release(b);}});
        System.out.println("RESULT scenarios="+scenarios+" checks="+checks+" owner=main worker=real-thread");
    }
}
