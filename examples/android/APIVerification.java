package dev.aster.charts;
import android.graphics.*;
import org.json.*;

/** Actual Java values cross the public JNI facade; called by the native app. */
final class APIVerification {
    private final JSONArray checks=new JSONArray();
    private void check(boolean value,String reason){if(!value)throw new AssertionError(reason);checks.put(reason);}
    private JSONObject row(long time,double close) throws JSONException {return new JSONObject().put("time",time).put("open",1.2e-12).put("high",2e-12).put("low",1e-12).put("close",close).put("volume",7);}
    private JSONObject inspect(AsterEngine e) throws JSONException {return (JSONObject)e.command("inspect");}
    private JSONObject comparisonAxis(JSONObject scene)throws JSONException {JSONArray axes=scene.getJSONObject("layout").getJSONArray("panels").getJSONObject(0).getJSONArray("axes");for(int i=0;i<axes.length();i++)if("comparison-B".equals(axes.getJSONObject(i).optString("axisId")))return axes.getJSONObject(i);throw new AssertionError("Missing comparison axis layout");}
    static String comparisonLabel(JSONObject packet)throws JSONException {
        JSONObject reading=packet.optJSONObject("reading");if(reading==null)return packet.getString("text");JSONObject bar=reading.getJSONObject("primary").getJSONObject("bar");String b="removed";JSONArray series=reading.getJSONArray("series");for(int i=0;i<series.length();i++){JSONObject s=series.getJSONObject(i);if("comparison-B-line".equals(s.getString("id")))b=s.isNull("value")?"gap":String.format(java.util.Locale.ROOT,"%.3f",s.getDouble("value"));}
        return String.format(java.util.Locale.ROOT,"A OHLCV · O %.2f H %.2f L %.2f C %.2f V %.0f / SYNTH:B %s / UTC %d",bar.getDouble("open"),bar.getDouble("high"),bar.getDouble("low"),bar.getDouble("close"),bar.getDouble("volume"),b,reading.getLong("time"));
    }
    private double[] comparisonPoint(AsterEngine e,double width,double height,int index,double price)throws JSONException {
        JSONObject scene=e.scene(width,height),p=scene.getJSONObject("layout").getJSONArray("panels").getJSONObject(0),a=comparisonAxis(scene),view=inspect(e).getJSONObject("view");double min=a.getDouble("min"),max=a.getDouble("max"),v=price;
        if("log".equals(a.getString("scale"))){min=Math.log(min);max=Math.log(max);v=Math.log(v);}double fraction=(v-min)/(max-min);if(!a.getBoolean("inverted"))fraction=1-fraction;
        return new double[]{p.getDouble("left")+(index-view.getDouble("from"))/(view.getDouble("to")-view.getDouble("from"))*(p.getDouble("right")-p.getDouble("left")),a.getDouble("top")+fraction*(a.getDouble("bottom")-a.getDouble("top"))};
    }
    private JSONObject comparisonMove(AsterEngine e,AsterChartView view,int index)throws JSONException {
        float density=view.getResources().getDisplayMetrics().density;double width=view.getWidth()/density,height=view.getHeight()/density;double[] p=comparisonPoint(e,width,height,index,2100);long time=android.os.SystemClock.uptimeMillis();
        for(int action:new int[]{android.view.MotionEvent.ACTION_DOWN,android.view.MotionEvent.ACTION_MOVE,android.view.MotionEvent.ACTION_UP}){android.view.MotionEvent event=android.view.MotionEvent.obtain(time,time,action,(float)p[0]*density,(float)p[1]*density,0);view.dispatchTouchEvent(event);event.recycle();}
        return (JSONObject)e.invoke("nativeComparisonReadout",width,height);
    }
    /** Axis ABI plus synthetic MotionEvent routing through the actual Android View. */
    JSONObject runAxes(AsterEngine e,AsterChartView view)throws Exception {
        JSONObject shared=(JSONObject)e.invoke("nativeAxesSelfTest");check(shared.getJSONArray("checks").length()>0&&shared.getInt("passed")==shared.getJSONArray("checks").length(),"Shared independent-axis numerical checks");
        JSONObject setup=(JSONObject)e.invoke("nativeComparisonDemo");check(setup.getInt("bars")==24&&setup.getInt("matches")==12&&setup.getInt("gaps")==12,"Exact UTC join counts");view.setTool("select");
        float density=view.getResources().getDisplayMetrics().density;double width=view.getWidth()/density,height=view.getHeight()/density;JSONObject scene=e.scene(width,height),p=scene.getJSONObject("layout").getJSONArray("panels").getJSONObject(0),axis=comparisonAxis(scene);
        check(p.getDouble("min")==99&&p.getDouble("max")==125&&axis.getDouble("min")==2010&&axis.getDouble("max")==2220,"Independent raw price ranges through JNI");
        JSONObject matched=comparisonMove(e,view,2),gap=comparisonMove(e,view,3);check(comparisonLabel(matched).contains("C 103.00")&&comparisonLabel(matched).contains("SYNTH:B 2020.000"),"Android MotionEvent primary/B readout");check(comparisonLabel(gap).contains("C 104.00")&&comparisonLabel(gap).contains("SYNTH:B gap"),"Android MotionEvent exact UTC gap");
        long readRevision=e.revision();int[] readNotifications={0};Runnable readObserver=()->readNotifications[0]++;e.addChangeListener(readObserver);JSONObject genericRead;try{genericRead=(JSONObject)e.command("crosshairValues",width,height);}finally{e.removeChangeListener(readObserver);}check(e.revision()==readRevision&&readNotifications[0]==0&&genericRead.getInt("index")==3,"Java crosshair read preserves revision and observers");
        e.command("addAxis",new JSONObject().put("id","java-percent").put("panel","price").put("scale","percent").put("base",2000).put("range",new JSONArray().put(2000).put(4000)));e.command("setAxis","java-percent",new JSONObject().put("visible",false));e.command("removeAxis","java-percent");check(inspect(e).getJSONArray("axes").length()==1,"Generic Java add/set/remove axis ABI");
        e.command("setAxis","comparison-B",new JSONObject().put("scale","percent").put("base",2000).put("range",new JSONArray().put(2000).put(4000)).put("precision",1));double[] percent=comparisonPoint(e,width,height,2,3000);e.invoke("nativePointer","move",0,percent[0],percent[1]);JSONArray values=((JSONObject)e.invoke("nativeComparisonReadout",width,height)).getJSONObject("reading").getJSONArray("axes");String formatted="";for(int i=0;i<values.length();i++)if("comparison-B".equals(values.getJSONObject(i).optString("id")))formatted=values.getJSONObject(i).getString("formatted");check(formatted.equals("B 50.0%"),"Java independent percent base/precision");
        String before=inspect(e).toString();boolean rejected=false;try{e.command("setAxis","comparison-B",new JSONObject().put("base",0));}catch(IllegalStateException expected){rejected=true;}check(rejected&&before.equals(inspect(e).toString()),"Zero percent base rejects atomically");
        e.invoke("nativeComparisonDemo");view.setTool("trendline");double[] first=comparisonPoint(e,width,height,2,2080),last=comparisonPoint(e,width,height,6,2160);long time=android.os.SystemClock.uptimeMillis();for(int action:new int[]{android.view.MotionEvent.ACTION_DOWN,android.view.MotionEvent.ACTION_MOVE,android.view.MotionEvent.ACTION_UP}){double[] q=action==android.view.MotionEvent.ACTION_DOWN?first:last;android.view.MotionEvent event=android.view.MotionEvent.obtain(time,time,action,(float)q[0]*density,(float)q[1]*density,0);view.dispatchTouchEvent(event);event.recycle();}
        JSONObject drawing=new JSONObject(e.saveDrawings()).getJSONArray("drawings").getJSONObject(0);check(drawing.getString("axisId").equals("comparison-B")&&drawing.getString("seriesId").equals("comparison-B-line")&&Math.abs(drawing.getJSONArray("points").getJSONObject(0).getDouble("price")-2080)<0.01&&Math.abs(drawing.getJSONArray("points").getJSONObject(1).getDouble("price")-2160)<0.01,"Android drawing gesture saves B raw anchors");
        String saved=e.saveDrawings();check(new JSONObject(saved).getInt("version")==2,"Bound Java drawing exports v2");e.undo();e.redo();check(saved.equals(e.saveDrawings()),"Bound Java undo/redo exact document");e.invoke("nativeComparisonAction","save",width,height);
        e.invoke("nativeComparisonAction","hide-axis",width,height);e.invoke("nativeComparisonAction","series",width,height);String removed=e.saveDrawings();rejected=false;try{e.invoke("nativeComparisonAction","load",width,height,saved);}catch(IllegalStateException expected){rejected=true;}check(rejected&&removed.equals(e.saveDrawings()),"Missing binding import rejects atomically");e.invoke("nativeComparisonAction","series",width,height);e.invoke("nativeComparisonAction","load",width,height,saved);check(saved.equals(e.saveDrawings()),"Reconnected Java binding exact load");
        Bitmap bitmap=Bitmap.createBitmap(view.getWidth(),view.getHeight(),Bitmap.Config.ARGB_8888);view.draw(new Canvas(bitmap));int foreground=0;for(int y=0;y<bitmap.getHeight();y+=7)for(int x=0;x<bitmap.getWidth();x+=7)if(bitmap.getPixel(x,y)!=Color.rgb(12,19,32))foreground++;bitmap.recycle();check(view.lastError==null&&foreground>100,"Android independent axes raster");
        return new JSONObject().put("passed",checks.length()).put("checks",checks).put("shared",shared).put("matchedReadout",matched).put("gapReadout",gap).put("syntheticMotionEvents",true).put("externalSeriesIsOHLCV",false).put("physicalDevice",false);
    }
    JSONObject run(AsterEngine e,AsterChartView view) throws Exception {
        int[] notified={0};Runnable observer=()->notified[0]++;e.addChangeListener(observer);
        try {
            e.invoke("nativeInit",0);long t=1700000000123L;
            e.setData(new JSONArray().put(row(t,1.345678901234e-12)));
            check(inspect(e).getJSONObject("lastBar").getDouble("close")==1.345678901234e-12,"Java external OHLCV Float64 injection");
            e.applyDataEvent(new JSONObject().put("kind","append").put("bar",row(t+60000,1.345678901234e-12)));
            e.applyDataEvent(new JSONObject().put("kind","update").put("bar",row(t+60000,1.8e-12)));
            e.applyDataEvent(new JSONObject().put("kind","correction").put("bar",row(t,1.6e-12)));
            e.applyDataEvent(new JSONObject().put("kind","prepend").put("bars",new JSONArray().put(row(t-60000,1.345678901234e-12))));
            check(inspect(e).getInt("storedBars")==3,"Java append/update/correction/prepend");
            e.addPanel(new JSONObject().put("id","momentum").put("weight",1));e.setPanel("momentum",new JSONObject().put("range",new JSONArray().put(0).put(100)).put("precision",3));
            JSONObject indicator=e.addIndicator("r","rsi",new JSONObject().put("period",2));check(indicator.getJSONArray("outputs").getString(0).equals("value"),"Indicator output selection metadata");
            e.addSeries(new JSONObject().put("id","r-line").put("type","line").put("panel","momentum").put("indicator","r").put("output","value").put("color","rgba(255,0,0,0.5)"));e.setSeries("r-line",new JSONObject().put("visible",false).put("width",3));e.removeIndicator("r");check(inspect(e).getJSONArray("series").length()==3,"Remove indicator cleans only its plotted series");
            e.registerIndicatorSource("double","() => ({outputs:['value'],create(){return {step:b=>[b.close*2],snapshot:()=>0,restore:()=>{}}}})");e.addIndicator("custom","double",new JSONObject());JSONArray output=(JSONArray)e.command("indicatorValues","custom","value");check(output.getDouble(2)==3.6e-12,"Trusted custom indicator source in QuickJS");
            e.addSeries(new JSONObject().put("id","values").put("type","line").put("panel","price").put("values",new JSONArray().put(JSONObject.NULL).put(1e-12).put(2e-12)));e.setSeriesValues("values",new JSONArray().put(JSONObject.NULL).put(1.2e-12).put(1.7e-12));e.removeSeries("values");
            e.setTheme(new JSONObject().put("background","#123").put("font","italic bold 20px sans-serif").put("up","lime"));
            e.setSymbol(new JSONObject().put("id","TINY").put("exchange","SYNTH").put("timezone","America/New_York").put("currency","USD").put("priceDecimals",15).put("tickSize",1e-15).put("volumeUnit","units").put("adjustment","raw"));
            JSONObject scene=e.scene(1200,700);JSONArray sceneCommands=scene.getJSONArray("commands");int textCommands=0;boolean matchingFonts=true;for(int i=0;i<sceneCommands.length();i++){JSONObject command=sceneCommands.getJSONObject(i);if("text".equals(command.getString("op"))){textCommands++;matchingFonts&=command.getString("font").equals("italic bold 20px sans-serif");}}check(scene.getString("background").equals("#112233ff")&&textCommands>0&&matchingFonts,"Portable theme and font reach every native theme text command");
            String id=e.addDrawing(new JSONObject().put("type","text").put("points",new JSONArray().put(new JSONObject().put("time",t).put("price",1.6e-12))).put("text","한국 🚀").put("style",new JSONObject().put("font","bold 18px serif").put("color","#abc")));
            e.editDrawing(id,new JSONObject().put("locked",true));check(!e.deleteDrawing(id),"Programmatic drawing lock");e.editDrawing(id,new JSONObject().put("locked",false));e.editDrawing(id,new JSONObject().put("text","edited 🚀"));e.selectDrawing(id);
            String saved=e.saveDrawings();e.undo();e.redo();check(e.saveDrawings().equals(saved),"Common undo/redo restores exact drawing");e.deleteDrawing(id);e.loadDrawings(saved);check(e.saveDrawings().equals(saved),"Common drawing storage roundtrip");
            int before=notified[0];e.command("inspect");e.command("indicatorValues","custom");boolean rejected=false;try{e.setTheme(new JSONObject().put("font","invalid"));}catch(IllegalStateException error){rejected=true;}check(rejected&&before==notified[0],"Failed mutations and reads do not notify native view");
            java.util.concurrent.atomic.AtomicBoolean wrong=new java.util.concurrent.atomic.AtomicBoolean(false);Thread worker=new Thread(()->{try{e.command("inspect");}catch(IllegalStateException error){wrong.set(true);}catch(Exception error){}});worker.start();worker.join(2000);check(wrong.get(),"Java engine owner-thread guard");
            JSONObject columns=new JSONObject();JSONObject b=row(t,1.345678901234e-12);for(String key:new String[]{"time","open","high","low","close","volume"})columns.put(key,new JSONArray().put(b.get(key)));e.setColumns(columns);check(inspect(e).getInt("storedBars")==1&&notified[0]>20,"Column input and mutation observers");
            int small=textInk(view,"12px monospace"),large=textInk(view,"bold 36px monospace");check(large>small*2,"Native font size changes raster coverage");
            int[] afterFailure={0};Runnable failing=()->{throw new IllegalStateException("observer failure");},following=()->afterFailure[0]++;e.addChangeListener(failing);e.addChangeListener(following);e.setTheme(new JSONObject().put("background","#123"));if(afterFailure[0]!=1||e.observerErrors().size()!=1)throw new AssertionError("Observer failure interrupted delivery");e.removeChangeListener(failing);e.removeChangeListener(following);
            JSONObject hardening=(JSONObject)e.invoke("nativeHardeningSelfTest");if(hardening.getInt("passed")!=8)throw new AssertionError("Native hardening failed");
            Bitmap guard=Bitmap.createBitmap(16,16,Bitmap.Config.ARGB_8888);Canvas canvas=new Canvas(guard);int saveCount=canvas.getSaveCount();try{view.render(canvas,new JSONObject().put("background","#000000").put("commands",new JSONArray().put(new JSONObject().put("op","text").put("color","invalid"))));}catch(IllegalArgumentException expected){}if(canvas.getSaveCount()!=saveCount)throw new AssertionError("Canvas state leak on invalid scene");guard.recycle();e.invoke("nativeInit",10000);
            return new JSONObject().put("passed",checks.length()).put("checks",checks).put("mutationNotifications",notified[0]).put("fontSmallInk",small).put("fontLargeInk",large).put("observerFailureIsolated",true).put("hardening",hardening).put("canvasStateRestored",true);
        } finally {e.removeChangeListener(observer);}
    }
    private int textInk(AsterChartView view,String font) throws JSONException {
        Bitmap bitmap=Bitmap.createBitmap(240,100,Bitmap.Config.ARGB_8888);
        JSONObject command=new JSONObject().put("op","text").put("x",10).put("y",80).put("text","MMMM").put("color","#ffffff").put("font",font);
        view.render(new Canvas(bitmap),new JSONObject().put("background","#000000").put("commands",new JSONArray().put(command)));
        int ink=0;for(int y=0;y<100;y++)for(int x=0;x<240;x++){int color=bitmap.getPixel(x,y);if(Color.red(color)+Color.green(color)+Color.blue(color)>100)ink++;}bitmap.recycle();return ink;
    }
}
