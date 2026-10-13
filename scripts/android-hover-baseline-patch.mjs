// Instrumentation-only overlay for immutable0.2.6 Java copied into a scratch directory.
// The old drawing/command ordering is retained; these exact seams also exist in candidate.
export function patchBaselineEngine(source){
 const before='    public JSONObject scene(double width,double height) throws JSONException {return new JSONObject((String)invoke("nativeSceneJSON",width,height));}';
 if(!source.includes(before))throw new Error('Pinned baseline scene seam changed');
 return source.replace(before,`    static final class SceneTiming {
        final long jniNanos,envelopeParseNanos,bodyParseNanos;final int jsonChars;
        SceneTiming(long jni,long envelope,long body,int chars){jniNanos=jni;envelopeParseNanos=envelope;bodyParseNanos=body;jsonChars=chars;}
    }
    private SceneTiming sceneTiming=new SceneTiming(0,0,0,0);
    SceneTiming sceneTiming(){check();return sceneTiming;}
    private JSONObject sceneJSON(String name,Object... args) throws JSONException {
        check();String arguments=new JSONArray(args).toString();long start=System.nanoTime();
        String returned=call(handle,name,arguments);long afterJNI=System.nanoTime();
        String body=(String)new JSONArray("["+returned+"]").get(0);long afterEnvelope=System.nanoTime();
        JSONObject scene=new JSONObject(body);long afterBody=System.nanoTime();
        sceneTiming=new SceneTiming(afterJNI-start,afterEnvelope-afterJNI,afterBody-afterEnvelope,body.length());return scene;
    }
    public JSONObject scene(double width,double height) throws JSONException {return sceneJSON("nativeSceneJSON",width,height);}`);
}
export function patchBaselineView(source){
 const before=source.slice(source.indexOf('    @Override protected void onDraw(Canvas canvas)'),source.indexOf('    public void render(Canvas canvas'));
 if(!before.includes('render(canvas,engine.scene(')||before.includes('drawProbe'))throw new Error('Pinned baseline draw seam changed');
 source=source.replace('    private final Runnable onChange=()->invalidate();',`    private final Runnable onChange=()->invalidate();
    interface DrawProbe {void submitted(DrawTiming timing);}
    static final class DrawTiming {
        final long startNanos,submitNanos,canvasNanos,accessibilityNanos;final AsterEngine.SceneTiming scene;
        final long baseRasterNanos=0,drawingRasterNanos=0,bitmapCopyNanos=0,hoverNanos=0;
        final boolean cacheUsed=false,baseChanged=false,drawingsChanged=false;
        DrawTiming(long start,long submit,long canvas,long accessibility,AsterEngine.SceneTiming scene){startNanos=start;submitNanos=submit;canvasNanos=canvas;accessibilityNanos=accessibility;this.scene=scene;}
    }
    private DrawProbe drawProbe;
    void setDrawProbe(DrawProbe probe){drawProbe=probe;}`);
 source=source.replace('onDetachedFromWindow(){engine.removeChangeListener','onDetachedFromWindow(){drawProbe=null;engine.removeChangeListener');
 return source.replace(before,`    @Override protected void onDraw(Canvas canvas){long start=System.nanoTime(),canvasNanos=0,accessibilityNanos=0;super.onDraw(canvas);canvas.save();canvas.scale(density,density);
        try{JSONObject scene=engine.scene(Math.max(100,getWidth()/density),Math.max(80,getHeight()/density));long beforeCanvas=System.nanoTime();render(canvas,scene);canvasNanos=System.nanoTime()-beforeCanvas;lastError=null;renderedRevision=engine.revision();long beforeAccessibility=System.nanoTime();JSONObject summary=(JSONObject)engine.invoke("nativeAccessibility");setContentDescription(summary.getInt("bars")+" bars; close "+summary.getString("close")+"; "+summary.getString("selection"));accessibilityNanos=System.nanoTime()-beforeAccessibility;}catch(Exception e){lastError=e.toString();paint.setColor(Color.RED);paint.setTextSize(12);canvas.drawText(lastError,12,30,paint);}canvas.restore();
        if(drawProbe!=null)drawProbe.submitted(new DrawTiming(start,System.nanoTime(),canvasNanos,accessibilityNanos,engine.sceneTiming()));
    }
`);
}
