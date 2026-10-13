package dev.aster.charts;

import android.view.MotionEvent;
import org.json.*;

/** Attached View/QuickJS boundary checks. Public fire and synthetic MotionEvent
 * inputs are deliberately distinct from OS InputDispatcher injection. */
final class PublicInputVerification {
    private final JSONArray checks=new JSONArray(),rows=new JSONArray();
    private boolean passed=true;
    private void check(boolean value,String reason)throws JSONException {checks.put(new JSONObject().put("check",reason).put("passed",value));passed&=value;}
    private JSONObject inspect(AsterEngine engine)throws JSONException{return (JSONObject)engine.command("inspect");}
    private double[] point(AsterEngine engine,AsterChartView view)throws JSONException {
        float d=view.getResources().getDisplayMetrics().density;
        JSONObject p=engine.scene(view.getWidth()/d,view.getHeight()/d).getJSONObject("layout").getJSONArray("panels").getJSONObject(0);
        return new double[]{(p.getDouble("left")+p.getDouble("right"))/2,(p.getDouble("top")+p.getDouble("bottom"))/2};
    }
    private void reset(AsterEngine engine,AsterChartView view)throws JSONException {
        view.fire("nativePointer","cancel",0,0,0);
        engine.invoke("nativeInit",0,new JSONObject().put("panels",new JSONArray().put(new JSONObject().put("id","price"))).put("series",new JSONArray().put(new JSONObject().put("id","price").put("panel","price").put("type","candles"))));
        JSONArray bars=new JSONArray();for(int i=0;i<5;i++)bars.put(new JSONObject().put("time",1700000000000L+i*60000L).put("open",100+i).put("high",104+i).put("low",96+i).put("close",100+i).put("volume",10));engine.setData(bars);engine.fit();engine.setTool("rectangle");
    }
    private void synthetic(AsterChartView view,int action,double[] p,long time){float d=view.getResources().getDisplayMetrics().density;MotionEvent event=MotionEvent.obtain(time,time,action,(float)p[0]*d,(float)p[1]*d,0);try{view.dispatchTouchEvent(event);}finally{event.recycle();}}
    JSONObject run(AsterEngine engine,AsterChartView view,boolean accessibility)throws Exception {
        int left=view.getLeft(),top=view.getTop(),width=view.getWidth(),height=view.getHeight();
        if(width<360||height<80||!view.isAttachedToWindow())throw new IllegalStateException("Attached wide View required");
        try {
            reset(engine,view);double[] p=point(engine,view);view.fire("nativePointer","down",1,p[0],p[1]);
            check(inspect(engine).getInt("pointers")==1&&"create".equals(inspect(engine).optString("gesture")),"Public DOWN creates active native input");
            view.layout(left,top,left+width,top+height);check(inspect(engine).getInt("pointers")==1&&"create".equals(inspect(engine).optString("gesture")),"Same-size layout preserves public gesture");
            view.layout(left,top,left+width-180,top+height);JSONObject afterResize=inspect(engine);view.fire("nativePointer","up",1,0,0);JSONObject afterUp=inspect(engine);
            rows.put(new JSONObject().put("kind","public-create").put("afterResize",afterResize).put("afterUp",afterUp));
            check(afterResize.getInt("pointers")==0&&afterResize.isNull("gesture")&&afterResize.getJSONArray("drawings").length()==0,"Changed-size layout cancels public pointer and provisional drawing");
            check(afterUp.getJSONArray("drawings").length()==0,"Public UP after resize cannot commit cancelled creation");
            engine.undo();engine.redo();check(inspect(engine).getJSONArray("drawings").length()==0,"Cancelled creation leaves no undo/redo entry");

            view.layout(left,top,left+width,top+height);reset(engine,view);
            String id=engine.addDrawing(new JSONObject().put("type","horizontal").put("points",new JSONArray().put(new JSONObject().put("time",1700000060000L).put("price",102))));String committed=engine.saveDrawings();engine.setTool("select");p=point(engine,view);
            JSONObject panel=engine.scene(view.getWidth()/view.getResources().getDisplayMetrics().density,view.getHeight()/view.getResources().getDisplayMetrics().density).getJSONObject("layout").getJSONArray("panels").getJSONObject(0);
            double y=panel.getDouble("top")+(1-(102-panel.getDouble("min"))/(panel.getDouble("max")-panel.getDouble("min")))*(panel.getDouble("bottom")-panel.getDouble("top"));
            view.fire("nativePointer","down",1,p[0],y);check("edit".equals(inspect(engine).optString("gesture")),"Public DOWN edits committed drawing");view.fire("nativePointer","move",1,p[0],y+30);
            check(inspect(engine).getJSONArray("drawings").getJSONObject(0).getJSONArray("points").getJSONObject(0).getDouble("price")!=102,"Public edit changes provisional raw price");
            view.layout(left,top,left+width-180,top+height);afterResize=inspect(engine);view.fire("nativePointer","up",1,0,0);afterUp=inspect(engine);rows.put(new JSONObject().put("kind","public-edit").put("afterResize",afterResize).put("afterUp",afterUp));
            check(afterResize.getInt("pointers")==0&&afterResize.isNull("gesture"),"Resize clears public edit pointer/gesture");check(committed.equals(engine.saveDrawings()),"Resize and late UP restore exact committed raw anchors");engine.undo();check(inspect(engine).getJSONArray("drawings").length()==0,"Resize cancellation adds no edit undo entry");engine.redo();check(committed.equals(engine.saveDrawings())&&id.equals(inspect(engine).getJSONArray("drawings").getJSONObject(0).getString("id")),"Redo restores original committed drawing");

            view.layout(left,top,left+width,top+height);reset(engine,view);p=point(engine,view);long time=android.os.SystemClock.uptimeMillis();synthetic(view,MotionEvent.ACTION_DOWN,p,time);check(inspect(engine).getInt("pointers")==1,"Synthetic View MotionEvent activates host touch path");view.layout(left,top,left+width-180,top+height);afterResize=inspect(engine);synthetic(view,MotionEvent.ACTION_UP,p,time+1);afterUp=inspect(engine);rows.put(new JSONObject().put("kind","synthetic-MotionEvent").put("afterResize",afterResize).put("afterUp",afterUp));check(afterResize.getInt("pointers")==0&&afterResize.isNull("gesture")&&afterUp.getJSONArray("drawings").length()==0,"Synthetic View touch resize/late UP preserves cancellation");

            if(accessibility){view.layout(left,top,left+width,top+height);reset(engine,view);p=point(engine,view);view.fire("nativePointer","down",1,p[0],p[1]);boolean accepted=view.performAccessibilityAction(0x41535404,null);afterUp=inspect(engine);check(accepted&&afterUp.getInt("pointers")==0&&afterUp.isNull("gesture")&&afterUp.getJSONArray("drawings").length()==0,"Separate accessibility Cancel rolls back public creation (direct View action)");}
            return new JSONObject().put("passed",passed).put("checks",checks).put("rows",rows).put("physicalDevice",false).put("inputScope","Actual attached production View + QuickJS JNI on Android. Public fire and synthetic dispatchTouchEvent, direct layout callback/direct accessibility action; not OS-injected touch or TalkBack session.");
        } finally {view.fire("nativePointer","cancel",0,0,0);view.layout(left,top,left+width,top+height);}
    }
}
