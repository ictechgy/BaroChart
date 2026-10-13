package dev.aster.charts;

import android.app.Instrumentation;
import android.os.*;
import android.view.*;
import org.json.*;
import java.io.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Binding transactions in actual QuickJS with system-dispatched touch on an attached View. */
public final class HoverBindingVerification {
    private static final long TIME=1700000120000L;
    private final HoverActivity activity;
    private final Instrumentation instrumentation;
    private final JSONArray checks=new JSONArray(),events=new JSONArray();
    private final JSONObject documents=new JSONObject();
    private JSONObject axes;
    private String emptyDocument;
    private CountDownLatch captured;
    private int expectedAction;
    private JSONObject capture;
    private boolean systemGestureActive;
    private interface Action {void run() throws Exception;}
    private HoverBindingVerification(HoverActivity activity,Instrumentation instrumentation){this.activity=activity;this.instrumentation=instrumentation;}
    private void main(Action action) throws Exception {Throwable[] failure={null};instrumentation.runOnMainSync(()->{try{action.run();}catch(Throwable error){failure[0]=error;}});if(failure[0]!=null)throw new AssertionError(failure[0]);}
    private void require(boolean pass,String name){if(!pass)throw new AssertionError(name);checks.put(name);}
    private JSONObject inspect() throws Exception {return (JSONObject)activity.engine.command("inspect");}
    private JSONObject drawing() throws Exception {return inspect().getJSONArray("drawings").getJSONObject(0);}
    private JSONArray point(double price) throws Exception {return new JSONArray().put(new JSONObject().put("time",TIME).put("price",price));}
    private double[] screen(String id,double price) throws Exception {
        AsterChartView view=activity.chart;float density=view.getResources().getDisplayMetrics().density;double width=Math.max(100,view.getWidth()/density),height=Math.max(80,view.getHeight()/density);
        JSONObject scene=activity.engine.scene(width,height),panel=scene.getJSONObject("layout").getJSONArray("panels").getJSONObject(0),axis=null;JSONArray all=panel.getJSONArray("axes");for(int i=0;i<all.length();i++)if(id.equals(all.getJSONObject(i).optString("axisId")))axis=all.getJSONObject(i);if(axis==null)throw new AssertionError("Missing axis "+id);
        JSONObject visible=inspect().getJSONObject("view");double x=panel.getDouble("left")+(2-visible.getDouble("from"))/(visible.getDouble("to")-visible.getDouble("from"))*(panel.getDouble("right")-panel.getDouble("left"));
        double fraction=(price-axis.getDouble("min"))/(axis.getDouble("max")-axis.getDouble("min"));if(!axis.getBoolean("inverted"))fraction=1-fraction;
        int[] location=new int[2];view.getLocationOnScreen(location);return new double[]{location[0]+x*density,location[1]+(axis.getDouble("top")+fraction*(axis.getDouble("bottom")-axis.getDouble("top")))*density};
    }
    private void touch(int action,double x,double y,long downTime) throws Exception {
        main(()->{expectedAction=action;capture=null;captured=new CountDownLatch(1);});
        MotionEvent.PointerProperties properties=new MotionEvent.PointerProperties();properties.id=0;properties.toolType=MotionEvent.TOOL_TYPE_FINGER;MotionEvent.PointerCoords coords=new MotionEvent.PointerCoords();coords.x=(float)x;coords.y=(float)y;coords.pressure=1;coords.size=1;
        MotionEvent event=MotionEvent.obtain(downTime,SystemClock.uptimeMillis(),action,1,new MotionEvent.PointerProperties[]{properties},new MotionEvent.PointerCoords[]{coords},0,0,1,1,0,0,InputDevice.SOURCE_TOUCHSCREEN,0);
        boolean accepted;try{accepted=instrumentation.getUiAutomation().injectInputEvent(event,true);}finally{event.recycle();}
        if(accepted){if(action==MotionEvent.ACTION_DOWN)systemGestureActive=true;else if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL)systemGestureActive=false;}
        require(accepted,"system touch "+action+" accepted");require(captured.await(5,TimeUnit.SECONDS),"system touch "+action+" captured by actual attached View");instrumentation.waitForIdleSync();
        main(()->{require(capture.getInt("source")==InputDevice.SOURCE_TOUCHSCREEN&&capture.getInt("tool")==MotionEvent.TOOL_TYPE_FINGER,"actual View touch source and tool preserved");events.put(capture);require(activity.chart.lastError==null,"system touch draws without native cache error");});
    }
    // A failed instrumentation turn must not leave the synthetic device pressed.
    // Also cancel an earlier failed turn before starting a fresh gesture stream.
    private boolean cancelSystemGesture(){long time=SystemClock.uptimeMillis();MotionEvent event=MotionEvent.obtain(time,time,MotionEvent.ACTION_CANCEL,0,0,0);event.setSource(InputDevice.SOURCE_TOUCHSCREEN);try{return instrumentation.getUiAutomation().injectInputEvent(event,true);}finally{event.recycle();systemGestureActive=false;}}
    private void rejects(Action action,String label) throws Exception {
        main(()->{JSONObject before=inspect();String state=before.toString(),anchors=before.getJSONArray("drawings").toString(),saved=before.isNull("gesture")?activity.engine.saveDrawings():null;long revision=activity.engine.revision();int[] notifications={0};Runnable observer=()->notifications[0]++;activity.engine.addChangeListener(observer);boolean rejected=false;
            try{action.run();}catch(IllegalStateException expected){rejected=true;}finally{activity.engine.removeChangeListener(observer);}
            require(rejected,label+": rejected through actual JNI");JSONObject after=inspect();require(state.equals(after.toString())&&anchors.equals(after.getJSONArray("drawings").toString())&&(saved==null||saved.equals(activity.engine.saveDrawings())),label+": gesture/pointers/selection/axes/anchors preserved atomically");require(activity.engine.revision()==revision&&notifications[0]==0,label+": no revision change or observer notification");
        });
    }
    private void run() throws Exception {
        main(()->{require(activity.chart.isAttachedToWindow(),"binding fixture uses an attached Android View");axes=new APIVerification().runAxes(activity.engine,activity.chart);require(axes.getInt("passed")==15&&axes.getJSONObject("shared").getInt("passed")==13,"existing Android axes15/shared13 actual-View API checks");
            activity.engine.invoke("nativeComparisonDemo");activity.engine.command("setAxis","comparison-B",new JSONObject().put("range",new JSONArray().put(1000).put(5000)).put("padding",0));activity.engine.command("addAxis",new JSONObject().put("id","transaction-C").put("panel","price").put("range",new JSONArray().put(0).put(100)).put("padding",0));
            activity.engine.command("addAxis",new JSONObject().put("id","transaction-D").put("panel","price").put("range",new JSONArray().put(0).put(100)).put("width",64).put("side","right"));activity.engine.addPanel(new JSONObject().put("id","other").put("range",new JSONArray().put(0).put(100)).put("axisVisible",false).put("axisSide","left"));activity.engine.command("addAxis",new JSONObject().put("id","margin-other").put("panel","other").put("range",new JSONArray().put(0).put(100)).put("width",128).put("side","left"));activity.engine.addSeries(new JSONObject().put("id","unrelated-stream").put("type","line").put("panel","other").put("axisId","margin-other").put("source","close"));
            emptyDocument=activity.engine.saveDrawings();activity.engine.addDrawing(new JSONObject().put("id","bound-edit").put("type","horizontal").put("panel","price").put("axisId","comparison-B").put("style",new JSONObject().put("color","#f5b85aff").put("width",1.5)).put("points",point(3000)));activity.engine.selectDrawing("bound-edit");activity.chart.setTool("select");
            activity.chart.setOnTouchListener((view,event)->{if(captured!=null&&capture==null&&event.getActionMasked()==expectedAction)try{capture=new JSONObject().put("action",event.getActionMasked()).put("source",event.getSource()).put("tool",event.getToolType(0)).put("eventTimeMs",event.getEventTime()).put("x",event.getX()).put("y",event.getY());captured.countDown();}catch(JSONException error){throw new RuntimeException(error);}return false;});
        });instrumentation.waitForIdleSync();
        double[][] start={null};String[] initial={null};main(()->{start[0]=screen("comparison-B",3000);initial[0]=activity.engine.saveDrawings();});long down=SystemClock.uptimeMillis();touch(MotionEvent.ACTION_DOWN,start[0][0],start[0][1],down);main(()->documents.put("stateAfterDown",inspect()));touch(MotionEvent.ACTION_MOVE,start[0][0],start[0][1]+20,down);
        main(()->{documents.put("stateAfterFirstMove",inspect());require("edit".equals(inspect().getString("gesture"))&&inspect().getInt("pointers")==1,"system down/move starts one live bound edit");require(Math.abs(drawing().getJSONArray("points").getJSONObject(0).getDouble("price")-3000)>.01,"live system movement changes B raw anchor before commit");});
        rejects(()->activity.engine.editDrawing("bound-edit",new JSONObject().put("axisId","missing")),"missing binding edit");
        rejects(()->activity.engine.editDrawing("bound-edit",new JSONObject().put("style",new JSONObject().put("width",99))),"invalid style edit");
        rejects(()->activity.engine.command("setAxis","comparison-B",new JSONObject().put("range",new JSONArray().put(0).put(100))),"related axis projection edit");
        rejects(()->activity.engine.setPanel("price",new JSONObject().put("padding",.2)),"related panel projection edit");
        main(()->{activity.engine.command("setAxis","transaction-C",new JSONObject().put("range",new JSONArray().put(0).put(200)));require("edit".equals(inspect().getString("gesture"))&&inspect().getInt("pointers")==1,"unrelated axis change preserves active edit");activity.engine.command("setAxis","transaction-C",new JSONObject().put("range",new JSONArray().put(0).put(100)));require(!activity.engine.deleteDrawing("missing"),"missing delete is a no-op");require("edit".equals(inspect().getString("gesture")),"missing delete preserves active gesture");
            activity.engine.editDrawing("bound-edit",new JSONObject().put("axisId","transaction-C").put("points",point(50)));require(inspect().isNull("gesture")&&inspect().getInt("pointers")==0,"public rebind cancels old gesture and pointers");require("transaction-C".equals(drawing().getString("axisId"))&&drawing().getJSONArray("points").getJSONObject(0).getDouble("price")==50,"public rebind publishes exact C raw anchor50");
        });
        touch(MotionEvent.ACTION_MOVE,start[0][0],start[0][1],down);touch(MotionEvent.ACTION_UP,start[0][0],start[0][1],down);
        String[] rebound={null};double[][] same={null};main(()->{require(drawing().getJSONArray("points").getJSONObject(0).getDouble("price")==50&&"transaction-C".equals(drawing().getString("axisId")),"stale system move/up cannot overwrite public rebind");rebound[0]=activity.engine.saveDrawings();documents.put("initial",initial[0]).put("rebound",rebound[0]);same[0]=screen("transaction-C",50);require(Math.abs(same[0][0]-start[0][0])<.001&&Math.abs(same[0][1]-start[0][1])<.001,"same screen coordinates map B3000 and C50 independently");});
        down=SystemClock.uptimeMillis();touch(MotionEvent.ACTION_DOWN,same[0][0],same[0][1],down);touch(MotionEvent.ACTION_MOVE,same[0][0],same[0][1]+20,down);main(()->require("edit".equals(inspect().getString("gesture"))&&Math.abs(drawing().getJSONArray("points").getJSONObject(0).getDouble("price")-50)>.01,"fresh same-coordinate system edit uses C domain"));
        rejects(()->activity.engine.command("setAxis","transaction-D",new JSONObject().put("width",128)),"unused axis width changes global margin");
        rejects(()->activity.engine.command("setAxis","transaction-D",new JSONObject().put("side","left")),"unused axis side changes global margin");
        rejects(()->activity.engine.command("setAxis","transaction-D",new JSONObject().put("visible",false)),"unused axis visibility changes global margin");
        rejects(()->activity.engine.command("removeAxis","transaction-D"),"unused axis removal changes global margin");
        rejects(()->activity.engine.command("addAxis",new JSONObject().put("id","temporary-E").put("panel","price")),"new axis changes global margin");
        rejects(()->activity.engine.setPanel("other",new JSONObject().put("axisVisible",true)),"other panel axis changes global margin");
        String[] live={null},newView={null};main(()->{activity.engine.command("setAxis","transaction-D",new JSONObject().put("range",new JSONArray().put(0).put(200)));require("edit".equals(inspect().getString("gesture"))&&inspect().getInt("pointers")==1,"unused axis range preserves active edit and global margins");activity.engine.removeSeries("unrelated-stream");require("edit".equals(inspect().getString("gesture"))&&inspect().getInt("pointers")==1,"unrelated series removal preserves the bound edit");live[0]=inspect().getJSONArray("drawings").toString();});
        touch(MotionEvent.ACTION_MOVE,same[0][0],same[0][1]+20,down);main(()->{require(live[0].equals(inspect().getJSONArray("drawings").toString()),"identical system move after rejected margin changes has exact raw time/price parity");String old=inspect().getJSONObject("view").toString();activity.engine.command("zoom",.9,.5);newView[0]=inspect().getJSONObject("view").toString();require(!old.equals(newView[0]),"public zoom actually changes viewport during edit");});
        touch(MotionEvent.ACTION_MOVE,same[0][0],same[0][1]+20,down);main(()->{require(inspect().isNull("gesture")&&inspect().getInt("pointers")==0,"system move after viewport projection change clears edit ownership");require(rebound[0].equals(activity.engine.saveDrawings()),"viewport projection guard restores exact committed C50 anchors");require(newView[0].equals(inspect().getJSONObject("view").toString()),"viewport projection cancellation preserves the new public zoom view");});touch(MotionEvent.ACTION_CANCEL,same[0][0],same[0][1]+20,down);
        main(()->{documents.put("afterCancel",activity.engine.saveDrawings());require(rebound[0].equals(activity.engine.saveDrawings())&&inspect().isNull("gesture")&&inspect().getInt("pointers")==0,"system cancel restores C anchors and retains independent public edit");activity.engine.undo();documents.put("afterUndo",activity.engine.saveDrawings());require(initial[0].equals(activity.engine.saveDrawings()),"one undo restores exact original B3000 document");activity.engine.undo();documents.put("afterSecondUndo",activity.engine.saveDrawings());require(emptyDocument.equals(activity.engine.saveDrawings()),"second undo removes only the known initial add step");activity.engine.undo();require(emptyDocument.equals(activity.engine.saveDrawings()),"public rebind added exactly one independent undo step");activity.engine.redo();documents.put("afterFirstRedo",activity.engine.saveDrawings());require(initial[0].equals(activity.engine.saveDrawings()),"first redo restores initial B3000 add");activity.engine.redo();documents.put("afterRedo",activity.engine.saveDrawings());require(rebound[0].equals(activity.engine.saveDrawings()),"second redo restores exact C50 public rebind");activity.engine.removeSeries("comparison-B-line");});
        rejects(()->activity.engine.command("removeAxis","comparison-B"),"axis referenced only by undo history");main(()->{activity.engine.loadDrawings(rebound[0]);require(rebound[0].equals(activity.engine.saveDrawings()),"public rebind document validates and roundtrips exactly");activity.chart.invalidate();});rejects(()->activity.engine.command("removeAxis","comparison-B"),"load preserves old-axis undo history reference");instrumentation.waitForIdleSync();main(()->require(activity.chart.lastError==null,"final bound geometry renders through Android Canvas/cache"));
    }
    public static JSONObject run(HoverActivity activity,Instrumentation instrumentation) throws Exception {
        HoverBindingVerification fixture=new HoverBindingVerification(activity,instrumentation);JSONObject report=new JSONObject().put("passed",false).put("checks",fixture.checks).put("systemTouchEvents",fixture.events).put("documents",fixture.documents).put("physicalDevice",false).put("androidAPI",Build.VERSION.SDK_INT).put("scope","Actual QuickJS JNI commands and attached Android View. Existing axes API uses synthetic MotionEvent View dispatch; new binding cases use UiAutomation system SOURCE_TOUCHSCREEN injection. Numerical raw anchors, same screen coordinates, atomic rejection, undo/redo/cancel; no physical presentation latency claim.");
        report.put("startupSystemCancelAccepted",fixture.cancelSystemGesture());
        try{fixture.run();report.put("passed",true);}catch(Throwable failure){StringWriter trace=new StringWriter();failure.printStackTrace(new PrintWriter(trace));report.put("error",failure.toString()).put("stack",trace.toString());}
        finally{if(fixture.systemGestureActive)report.put("failureSystemCancelAccepted",fixture.cancelSystemGesture());fixture.main(()->activity.chart.setOnTouchListener(null));}if(fixture.axes!=null)report.put("axes",fixture.axes);return report;
    }
}
