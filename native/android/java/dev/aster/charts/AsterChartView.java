package dev.aster.charts;
import android.content.Context;import android.content.res.Configuration;import android.graphics.*;import android.os.*;import android.view.*;import android.view.accessibility.AccessibilityNodeInfo;import org.json.*;

/** Android Canvas/Skia native view consuming the shared renderer-neutral scene. */
public final class AsterChartView extends View {
    public final AsterEngine engine;
    private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG),bitmapPaint=new Paint(),baseBitmapPaint=new Paint();
    private final float density;
    private static final java.util.concurrent.atomic.AtomicLong TOKENS=new java.util.concurrent.atomic.AtomicLong();
    private final String frameToken="android-view-"+TOKENS.incrementAndGet();
    private Bitmap baseBitmap,drawingBitmap;
    private boolean renderCacheEnabled=true,engineClosed=false,frameCacheCreated=false;
    private long retryAt=0,retryPolicyGeneration=-1,cacheHits=0,baseRebuilds=0,drawingRebuilds=0,fallbacks=0;
    private String cacheFailure=null;
    private long packetRetryAt,packetAttempts,packetFrames,legacyFrames,packetFailures,packetReleaseFailures,packetPreparationNanos;
    private long packetNumericBytes,packetMetadataChars;
    private String packetFailure=null;
    private boolean packetForceBase;
    private long baseRasterNanos,drawingRasterNanos,bitmapCopyNanos,hoverNanos;
    private boolean cacheUsed,baseChanged,drawingsChanged;
    private final int touchSlop;
    private boolean touching,dragging,drawingTouch,pinchTouch,parentOwned;
    private int firstPointer,inputDepth;
    private float downX,downY;
    private boolean systemFontScaleEnabled,applyingFont;
    private String baseFont,lastAppliedFont;
    // Weak values avoid a value -> View -> engine path keeping a weak key alive.
    private static final java.util.WeakHashMap<AsterEngine,java.lang.ref.WeakReference<AsterChartView>> FONT_OWNERS=new java.util.WeakHashMap<>();
    public static final int ACTION_ZOOM_IN=0x41535401,ACTION_ZOOM_OUT=0x41535402,ACTION_CLEAR_CROSSHAIR=0x41535403,ACTION_CANCEL_INTERACTION=0x41535404;
    public String lastError=null;
    public long renderedRevision=0;
    private final Runnable onChange=()->{if(systemFontScaleEnabled&&!applyingFont&&inputDepth==0)try{applySystemFontScale();}catch(Exception error){lastError=error.toString();}invalidate();};
    private final Runnable onClose=()->{engineClosed=true;resetTouch();releaseFontOwner();baseFont=lastAppliedFont=null;evictBitmapCache();drawProbe=null;invalidate();};
    interface DrawProbe {void submitted(DrawTiming timing);}
    static final class DrawTiming {
        final long startNanos,submitNanos,canvasNanos,accessibilityNanos;final AsterEngine.SceneTiming scene;
        final long baseRasterNanos,drawingRasterNanos,bitmapCopyNanos,hoverNanos,packetPreparationNanos;
        final boolean cacheUsed,baseChanged,drawingsChanged;
        DrawTiming(long start,long submit,long canvas,long accessibility,AsterEngine.SceneTiming scene){this(start,submit,canvas,accessibility,scene,0,0,0,0,false,false,false);}
        DrawTiming(long start,long submit,long canvas,long accessibility,AsterEngine.SceneTiming scene,long base,long drawings,long bitmap,long hover,boolean cache,boolean baseChanged,boolean drawingsChanged){this(start,submit,canvas,accessibility,scene,base,drawings,bitmap,hover,cache,baseChanged,drawingsChanged,0);}
        DrawTiming(long start,long submit,long canvas,long accessibility,AsterEngine.SceneTiming scene,long base,long drawings,long bitmap,long hover,boolean cache,boolean baseChanged,boolean drawingsChanged,long preparation){startNanos=start;submitNanos=submit;canvasNanos=canvas;accessibilityNanos=accessibility;this.scene=scene;baseRasterNanos=base;drawingRasterNanos=drawings;bitmapCopyNanos=bitmap;hoverNanos=hover;cacheUsed=cache;this.baseChanged=baseChanged;this.drawingsChanged=drawingsChanged;packetPreparationNanos=preparation;}
    }
    private DrawProbe drawProbe;
    void setDrawProbe(DrawProbe probe){drawProbe=probe;}
    private static void viewOwner(){if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Chart View requires main thread");}
    public AsterChartView(Context context,AsterEngine engine){super(context);this.engine=engine;density=getResources().getDisplayMetrics().density;touchSlop=ViewConfiguration.get(context).getScaledTouchSlop();baseBitmapPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC));setFocusable(true);setClickable(true);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);setContentDescription("Financial chart");}
    private static int color(String s){if(s.matches("#[0-9a-fA-F]{8}"))s="#"+s.substring(7,9)+s.substring(1,7);return Color.parseColor(s);}
    public void fire(String name,Object... args){inputDepth++;try{engine.invoke(name,args);}catch(Exception e){lastError=e.toString();}finally{inputDepth--;}invalidate();}
    public void setTool(String tool){try{engine.setTool(tool);lastError=null;}catch(Exception e){lastError=e.toString();}}
    /** Opt in to system fontScale by updating the engine's logical theme font.
     * One View may own scaling per engine. A caller theme font becomes the new base.
     * Disable/detach restores only a font still equal to this View's last applied value. */
    public void setSystemFontScaleEnabled(boolean enabled){viewOwner();if(engineClosed)throw new IllegalStateException("Chart engine closed");if(enabled==systemFontScaleEnabled)return;
        if(enabled){claimFontOwner();systemFontScaleEnabled=true;try{applySystemFontScale();}catch(Exception error){systemFontScaleEnabled=false;releaseFontOwner();baseFont=lastAppliedFont=null;throw new IllegalStateException("Cannot apply system fontScale",error);}}
        else {restoreSystemFont();systemFontScaleEnabled=false;releaseFontOwner();baseFont=lastAppliedFont=null;}
        invalidate();
    }
    public boolean isSystemFontScaleEnabled(){viewOwner();return systemFontScaleEnabled;}
    private void claimFontOwner(){java.lang.ref.WeakReference<AsterChartView> ref=FONT_OWNERS.get(engine);AsterChartView owner=ref==null?null:ref.get();if(owner!=null&&owner!=this)throw new IllegalStateException("One fontScale owner View per engine");FONT_OWNERS.put(engine,new java.lang.ref.WeakReference<>(this));}
    private void releaseFontOwner(){java.lang.ref.WeakReference<AsterChartView> ref=FONT_OWNERS.get(engine);if(ref!=null&&ref.get()==this)FONT_OWNERS.remove(engine);}
    private String themeFont()throws JSONException{return (String)engine.invoke("nativeThemeFont");}
    private void applySystemFontScale()throws JSONException {if(!systemFontScaleEnabled||engineClosed||applyingFont)return;claimFontOwner();String current=themeFont();if(lastAppliedFont==null||!current.equals(lastAppliedFont))baseFont=current;
        java.util.regex.Matcher matcher=FONT.matcher(baseFont);if(!matcher.matches())throw new IllegalStateException("Portable theme font required");double scale=Double.parseDouble(Float.toString(getResources().getConfiguration().fontScale));if(!Double.isFinite(scale)||scale<=0)throw new IllegalStateException("Invalid resource fontScale");
        double size=Math.max(4,Math.min(96,Double.parseDouble(matcher.group(2))*scale));String next=matcher.group(1)+java.math.BigDecimal.valueOf(size).stripTrailingZeros().toPlainString()+"px "+matcher.group(3);
        if(!next.equals(current)){cancelTouch();applyingFont=true;try{engine.setTheme(new JSONObject().put("font",next));}finally{applyingFont=false;}}
        lastAppliedFont=next;
    }
    private void restoreSystemFont(){if(engineClosed||lastAppliedFont==null||baseFont==null)return;try{if(themeFont().equals(lastAppliedFont)&&!baseFont.equals(lastAppliedFont)){cancelTouch();applyingFont=true;try{engine.setTheme(new JSONObject().put("font",baseFont));}finally{applyingFont=false;}}}catch(Exception error){lastError=error.toString();}}
    @Override protected void onConfigurationChanged(Configuration config){super.onConfigurationChanged(config);if(systemFontScaleEnabled)try{applySystemFontScale();}catch(Exception error){lastError=error.toString();}invalidate();}
    /** Disable for low-memory clients or direct-render diagnostics. */
    public void setRenderCacheEnabled(boolean enabled){viewOwner();if(renderCacheEnabled!=enabled){renderCacheEnabled=enabled;evictBitmapCache();retryAt=0;invalidate();}}
    public boolean isRenderCacheEnabled(){viewOwner();return renderCacheEnabled;}
    /** Process-wide CPU bitmap budget. Zero selects direct rendering. Default64MiB. */
    public static void setSharedCacheBudgetBytes(long bytes){AsterBitmapCachePool.INSTANCE.setBudget(bytes);}
    public static JSONObject sharedCacheMetrics() throws JSONException {return AsterBitmapCachePool.INSTANCE.metrics();}
    public JSONObject renderCacheMetrics() throws JSONException {viewOwner();return new JSONObject().put("ownedBitmapBytes",bitmapBytes()).put("cacheHits",cacheHits).put("baseRebuilds",baseRebuilds).put("drawingRebuilds",drawingRebuilds).put("fallbacks",fallbacks).put("failure",cacheFailure==null?JSONObject.NULL:cacheFailure).put("enabled",renderCacheEnabled).put("engineClosed",engineClosed).put("frameCacheCreated",frameCacheCreated).put("packetAttempts",packetAttempts).put("packetFrames",packetFrames).put("legacyFrames",legacyFrames).put("packetFailures",packetFailures).put("packetReleaseFailures",packetReleaseFailures).put("packetNumericBytes",packetNumericBytes).put("packetMetadataChars",packetMetadataChars).put("packetFailure",packetFailure==null?JSONObject.NULL:packetFailure);}
    private long bitmapBytes(){return (baseBitmap==null?0L:baseBitmap.getAllocationByteCount())+(drawingBitmap==null?0L:drawingBitmap.getAllocationByteCount());}
    // Drop Java ownership instead of recycle(): a hardware display list may still use a bitmap.
    void evictBitmapCache(){viewOwner();baseBitmap=null;drawingBitmap=null;AsterBitmapCachePool.INSTANCE.release(this);if(frameCacheCreated){frameCacheCreated=false;if(!engineClosed)try{engine.releaseFrameCache(frameToken);}catch(Exception ignored){}}retryAt=SystemClock.uptimeMillis()+500;retryPolicyGeneration=AsterBitmapCachePool.INSTANCE.generation();invalidate();}
    @Override protected void onAttachedToWindow(){super.onAttachedToWindow();AsterBitmapCachePool.INSTANCE.register(getContext());if(!engineClosed){engine.addChangeListener(onChange);engine.addCloseListener(onClose);if(systemFontScaleEnabled)try{applySystemFontScale();}catch(Exception error){lastError=error.toString();}}}
    @Override protected void onSizeChanged(int w,int h,int ow,int oh){if(w!=ow||h!=oh)cancelTouch(true);if(isAttachedToWindow())evictBitmapCache();retryAt=0;fire("nativeResize",Math.max(100,w/density),Math.max(80,h/density));}
    @Override protected void onDetachedFromWindow(){cancelTouch(true);drawProbe=null;engine.removeChangeListener(onChange);engine.removeCloseListener(onClose);restoreSystemFont();releaseFontOwner();lastAppliedFont=null;evictBitmapCache();super.onDetachedFromWindow();}
    @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(!focused)cancelTouch(true);}
    @Override public boolean onHoverEvent(MotionEvent event){if(event.isFromSource(InputDevice.SOURCE_MOUSE)){int action=event.getActionMasked();if(action==MotionEvent.ACTION_HOVER_ENTER||action==MotionEvent.ACTION_HOVER_MOVE)fire("nativePointer","move",0,event.getX()/density,event.getY()/density);else if(action==MotionEvent.ACTION_HOVER_EXIT)fire("nativeHoverExit");if(action==MotionEvent.ACTION_HOVER_ENTER||action==MotionEvent.ACTION_HOVER_MOVE||action==MotionEvent.ACTION_HOVER_EXIT)return true;}return super.onHoverEvent(event);}
    private void parentOwnership(boolean owned){if(parentOwned==owned)return;parentOwned=owned;ViewParent parent=getParent();if(parent!=null)parent.requestDisallowInterceptTouchEvent(owned);}
    private void resetTouch(){touching=dragging=drawingTouch=pinchTouch=false;parentOwnership(false);}
    private void cancelTouch(){cancelTouch(false);}
    // Public fire() may have created native input without this View's touch flag.
    private void cancelTouch(boolean force){if((touching||force)&&!engineClosed)fire("nativePointer","cancel",0,0,0);resetTouch();}
    @Override public boolean onTouchEvent(MotionEvent e){if(engineClosed||!isEnabled())return false;int action=e.getActionMasked(),i=e.getActionIndex();
        if(action==MotionEvent.ACTION_DOWN){cancelTouch();requestFocus();touching=true;firstPointer=e.getPointerId(i);downX=e.getX(i);downY=e.getY(i);fire("nativePointer","down",firstPointer+1,downX/density,downY/density,e.getToolType(i)==MotionEvent.TOOL_TYPE_FINGER?24:8);
            try{Object state=engine.invoke("nativeGestureKind");String gesture=state==JSONObject.NULL?"":(String)state;drawingTouch=gesture.equals("edit")||gesture.equals("create");if(gesture.isEmpty()){cancelTouch();return false;}parentOwnership(drawingTouch);}catch(Exception error){lastError=error.toString();cancelTouch();return false;}
        }else if(action==MotionEvent.ACTION_POINTER_DOWN&&touching){pinchTouch=dragging=true;parentOwnership(true);fire("nativePointer","down",e.getPointerId(i)+1,e.getX(i)/density,e.getY(i)/density,e.getToolType(i)==MotionEvent.TOOL_TYPE_FINGER?24:8);
        }else if(action==MotionEvent.ACTION_MOVE&&touching){int at=e.findPointerIndex(firstPointer);if(!pinchTouch&&!dragging&&at>=0){float dx=Math.abs(e.getX(at)-downX),dy=Math.abs(e.getY(at)-downY);if(Math.hypot(dx,dy)<=touchSlop&&!drawingTouch)return true;
                if(!drawingTouch&&dy>dx&&getParent()!=null){cancelTouch();return false;}dragging=true;parentOwnership(true);}
            if(dragging)for(int j=0;j<e.getPointerCount();j++)fire("nativePointer","move",e.getPointerId(j)+1,e.getX(j)/density,e.getY(j)/density);
        }else if((action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_POINTER_UP)&&touching){boolean click=action==MotionEvent.ACTION_UP&&!dragging&&!pinchTouch;
            if(click)fire("nativePointer","move",0,downX/density,downY/density);fire("nativePointer","up",e.getPointerId(i)+1,0,0);if(action==MotionEvent.ACTION_UP){resetTouch();if(click)performClick();}
        }else if(action==MotionEvent.ACTION_CANCEL)cancelTouch();return true;
    }
    @Override public boolean performClick(){super.performClick();return true;}
    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info){super.onInitializeAccessibilityNodeInfo(info);info.setClassName(AsterChartView.class.getName());info.setScrollable(!engineClosed);if(!engineClosed){info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD);info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_ZOOM_IN,"Zoom in"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_ZOOM_OUT,"Zoom out"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_CLEAR_CROSSHAIR,"Clear crosshair"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_CANCEL_INTERACTION,"Cancel interaction"));}}
    @Override public boolean performAccessibilityAction(int action,Bundle args){if(engineClosed||!isEnabled())return false;try{
        if(action==AccessibilityNodeInfo.ACTION_CLICK){cancelTouch();engine.invoke("nativePointer","move",0,getWidth()/density*.5,getHeight()/density*.35);invalidate();return performClick();}
        if(action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD||action==AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD){cancelTouch();engine.invoke("nativeKey",action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD?"ArrowRight":"ArrowLeft",true,false);invalidate();return true;}
        if(action==ACTION_ZOOM_IN||action==ACTION_ZOOM_OUT){cancelTouch();engine.command("zoom",action==ACTION_ZOOM_IN?.8:1.25);invalidate();return true;}
        if(action==ACTION_CLEAR_CROSSHAIR){engine.invoke("nativeHoverExit");invalidate();return true;}
        if(action==ACTION_CANCEL_INTERACTION){engine.invoke("nativePointer","cancel",0,0,0);resetTouch();invalidate();return true;}
    }catch(Exception error){lastError=error.toString();return false;}return super.performAccessibilityAction(action,args);}
    @Override public boolean onKeyDown(int code,KeyEvent event){String key;switch(code){case KeyEvent.KEYCODE_DPAD_LEFT:key="ArrowLeft";break;case KeyEvent.KEYCODE_DPAD_RIGHT:key="ArrowRight";break;case KeyEvent.KEYCODE_DPAD_UP:key="ArrowUp";break;case KeyEvent.KEYCODE_DPAD_DOWN:key="ArrowDown";break;case KeyEvent.KEYCODE_PAGE_UP:key="PageUp";break;case KeyEvent.KEYCODE_PAGE_DOWN:key="PageDown";break;case KeyEvent.KEYCODE_DEL:key="Backspace";break;case KeyEvent.KEYCODE_ESCAPE:key="Escape";break;case KeyEvent.KEYCODE_PLUS:case KeyEvent.KEYCODE_EQUALS:key="+";break;case KeyEvent.KEYCODE_MINUS:key="-";break;case KeyEvent.KEYCODE_Z:if(!event.isCtrlPressed())return super.onKeyDown(code,event);key="z";break;default:return super.onKeyDown(code,event);}fire("nativeKey",key,event.isCtrlPressed(),event.isShiftPressed());return true;}
    private void drawFrame(Canvas canvas) throws JSONException {
        double width=Math.max(100,getWidth()/density),height=Math.max(80,getHeight()/density);long beforeCanvas;
        boolean eligible=renderCacheEnabled&&isAttachedToWindow()&&getWidth()>0&&getHeight()>0;
        boolean retryAllowed=eligible&&(SystemClock.uptimeMillis()>=retryAt||retryPolicyGeneration!=AsterBitmapCachePool.INSTANCE.generation());
        if(retryAllowed){
            try{frameCacheCreated=true;PreparedPacket packet=readPacket("frame",width,height,baseBitmap==null);if(packet!=null){beforeCanvas=System.nanoTime();drawCached(canvas,packet);}else{JSONObject frame=engine.renderFrame(frameToken,width,height,baseBitmap==null||packetForceBase);packetForceBase=false;legacyFrames++;beforeCanvas=System.nanoTime();drawCached(canvas,frame);}cacheUsed=true;canvasDuration=System.nanoTime()-beforeCanvas;cacheFailure=null;retryAt=0;return;}
            catch(OutOfMemoryError|RuntimeException|JSONException error){cacheFailure=error.toString();evictBitmapCache();fallbacks++;retryAt=SystemClock.uptimeMillis()+500;retryPolicyGeneration=AsterBitmapCachePool.INSTANCE.generation();}
        }
        PreparedPacket packet=readPacket("scene",width,height,false);JSONObject scene=packet==null?engine.scene(width,height):null;if(scene!=null)legacyFrames++;beforeCanvas=System.nanoTime();canvas.save();try{canvas.scale(density,density);if(packet!=null)renderPrepared(canvas,packet,0,true);else render(canvas,scene);}finally{canvas.restore();}canvasDuration=System.nanoTime()-beforeCanvas;
    }
    private PreparedPacket readPacket(String mode,double width,double height,boolean force)throws JSONException {
        if(SystemClock.uptimeMillis()<packetRetryAt)return null;packetAttempts++;long preparation=0;
        try{AsterEngine.ScenePacket packet=engine.scenePacket(mode,mode.equals("frame")?frameToken:null,width,height,force);preparation=System.nanoTime();PreparedPacket prepared=preparePacket(packet);packetFrames++;packetNumericBytes+=packet.numbers.length*8L;packetMetadataChars+=engine.sceneTiming().jsonChars;packetRetryAt=0;return prepared;}
        catch(OutOfMemoryError|RuntimeException|JSONException error){packetFailures++;packetFailure=error.toString();packetRetryAt=SystemClock.uptimeMillis()+500;if(mode.equals("frame")){packetForceBase=true;try{engine.releaseFrameCache(frameToken);}catch(RuntimeException|JSONException releaseError){packetReleaseFailures++;packetFailure+="; release: "+releaseError;}}return null;}
        finally{if(preparation!=0)packetPreparationNanos+=System.nanoTime()-preparation;}
    }
    private long canvasDuration;
    private void drawCached(Canvas canvas,JSONObject frame) throws JSONException {
        JSONObject base=frame.optJSONObject("base"),drawings=frame.optJSONObject("drawings"),hover=frame.getJSONObject("hover");
        if(base==null&&baseBitmap==null)throw new JSONException("Frame omitted missing base");
        boolean wantsDrawings=drawings!=null?drawings.getJSONArray("commands").length()>0:drawingBitmap!=null;
        long pixels=(long)getWidth()*getHeight();if(pixels>Long.MAX_VALUE/8)throw new IllegalStateException("Bitmap extent overflow");long estimate=pixels*4*(wantsDrawings?2:1);
        if(!AsterBitmapCachePool.INSTANCE.reserve(this,estimate))throw new IllegalStateException("Shared bitmap budget exceeded");
        if(baseBitmap==null){baseBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);baseBitmap.setDensity(Bitmap.DENSITY_NONE);}
        if(wantsDrawings&&drawingBitmap==null){drawingBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);drawingBitmap.setDensity(Bitmap.DENSITY_NONE);}
        if(!wantsDrawings)drawingBitmap=null;
        if(!AsterBitmapCachePool.INSTANCE.reserve(this,bitmapBytes()))throw new IllegalStateException("Actual bitmap allocation exceeds shared budget");
        if(base!=null){long before=System.nanoTime();Canvas target=new Canvas(baseBitmap);target.scale(density,density);render(target,base);baseRasterNanos=System.nanoTime()-before;baseRebuilds++;baseChanged=true;}
        else cacheHits++;
        if(drawings!=null){long before=System.nanoTime();if(drawingBitmap!=null){drawingBitmap.eraseColor(Color.TRANSPARENT);Canvas target=new Canvas(drawingBitmap);target.scale(density,density);renderCommands(target,drawings.getJSONArray("commands"));}drawingRasterNanos=System.nanoTime()-before;drawingRebuilds++;drawingsChanged=true;}
        long before=System.nanoTime();canvas.drawBitmap(baseBitmap,0,0,baseBitmapPaint);if(drawingBitmap!=null)canvas.drawBitmap(drawingBitmap,0,0,bitmapPaint);bitmapCopyNanos=System.nanoTime()-before;
        before=System.nanoTime();canvas.save();try{canvas.scale(density,density);renderCommands(canvas,hover.getJSONArray("commands"));}finally{canvas.restore();}hoverNanos=System.nanoTime()-before;AsterBitmapCachePool.INSTANCE.touch(this);
    }
    private void drawCached(Canvas canvas,PreparedPacket prepared)throws JSONException {
        AsterEngine.ScenePacket frame=prepared.packet;int base=frame.layerCounts[0],drawings=frame.layerCounts[1];
        if(base<0&&baseBitmap==null)throw new JSONException("Packet omitted missing base");boolean wantsDrawings=drawings>=0?drawings>0:drawingBitmap!=null;
        long pixels=(long)getWidth()*getHeight();if(pixels>Long.MAX_VALUE/8)throw new IllegalStateException("Bitmap extent overflow");long estimate=pixels*4*(wantsDrawings?2:1);
        if(!AsterBitmapCachePool.INSTANCE.reserve(this,estimate))throw new IllegalStateException("Shared bitmap budget exceeded");
        if(baseBitmap==null){baseBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);baseBitmap.setDensity(Bitmap.DENSITY_NONE);}
        if(wantsDrawings&&drawingBitmap==null){drawingBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);drawingBitmap.setDensity(Bitmap.DENSITY_NONE);}if(!wantsDrawings)drawingBitmap=null;
        if(!AsterBitmapCachePool.INSTANCE.reserve(this,bitmapBytes()))throw new IllegalStateException("Actual bitmap allocation exceeds shared budget");
        if(base>=0){long start=System.nanoTime();Canvas target=new Canvas(baseBitmap);target.scale(density,density);renderPrepared(target,prepared,0,true);baseRasterNanos=System.nanoTime()-start;baseRebuilds++;baseChanged=true;}else cacheHits++;
        if(drawings>=0){long start=System.nanoTime();if(drawingBitmap!=null){drawingBitmap.eraseColor(Color.TRANSPARENT);Canvas target=new Canvas(drawingBitmap);target.scale(density,density);renderPrepared(target,prepared,1,false);}drawingRasterNanos=System.nanoTime()-start;drawingRebuilds++;drawingsChanged=true;}
        long start=System.nanoTime();canvas.drawBitmap(baseBitmap,0,0,baseBitmapPaint);if(drawingBitmap!=null)canvas.drawBitmap(drawingBitmap,0,0,bitmapPaint);bitmapCopyNanos=System.nanoTime()-start;
        start=System.nanoTime();canvas.save();try{canvas.scale(density,density);renderPrepared(canvas,prepared,2,false);}finally{canvas.restore();}hoverNanos=System.nanoTime()-start;AsterBitmapCachePool.INSTANCE.touch(this);
    }
    @Override protected void onDraw(Canvas canvas){long start=System.nanoTime(),accessibilityNanos=0;super.onDraw(canvas);canvasDuration=baseRasterNanos=drawingRasterNanos=bitmapCopyNanos=hoverNanos=packetPreparationNanos=0;cacheUsed=baseChanged=drawingsChanged=false;
        try{if(engineClosed)throw new IllegalStateException("Chart engine closed");drawFrame(canvas);lastError=null;renderedRevision=engine.revision();long beforeAccessibility=System.nanoTime();String description=(String)engine.invoke("nativeAccessibilityText",true,"android");if(!description.contentEquals(getContentDescription()))setContentDescription(description);accessibilityNanos=System.nanoTime()-beforeAccessibility;}catch(Exception e){lastError=e.toString();paint.setColor(Color.RED);paint.setTextSize(12);canvas.drawText(lastError,12,30,paint);}
        if(drawProbe!=null&&!engineClosed)drawProbe.submitted(new DrawTiming(start,System.nanoTime(),canvasDuration,accessibilityNanos,engine.sceneTiming(),baseRasterNanos,drawingRasterNanos,bitmapCopyNanos,hoverNanos,cacheUsed,baseChanged,drawingsChanged,packetPreparationNanos));
    }
    private static final class FontSpec {final Typeface typeface;final float size;FontSpec(Typeface typeface,float size){this.typeface=typeface;this.size=size;}}
    private static final class PreparedPacket {
        final AsterEngine.ScenePacket packet;final int background;final int[] colors;final FontSpec[] fonts;final DashPathEffect[] dashes;
        PreparedPacket(AsterEngine.ScenePacket packet,int background,int[] colors,FontSpec[] fonts,DashPathEffect[] dashes){this.packet=packet;this.background=background;this.colors=colors;this.fonts=fonts;this.dashes=dashes;}
    }
    private static FontSpec font(String value){java.util.regex.Matcher m=FONT.matcher(value);if(m.matches()){String prefix=m.group(1),family=m.group(3).split(",")[0].trim().replace("\"","").replace("'","");int style=(prefix.contains("bold")?Typeface.BOLD:0)|(prefix.contains("italic")?Typeface.ITALIC:0);return new FontSpec(Typeface.create(family,style),Float.parseFloat(m.group(2)));}return new FontSpec(Typeface.MONOSPACE,12);}
    private static PreparedPacket preparePacket(AsterEngine.ScenePacket packet){
        int[] colors=new int[packet.strings.length];boolean[] parsed=new boolean[colors.length];FontSpec[] fonts=new FontSpec[colors.length];DashPathEffect[] dashes=new DashPathEffect[packet.commandCount];double[] numbers=packet.numbers;
        int background=color(packet.background);
        for(int i=0;i<packet.commandCount;i++){int at=packet.commandStarts[i],op=(int)numbers[at],primary=(int)numbers[at+2],fill=(int)numbers[at+10];if(!parsed[primary]){colors[primary]=color(packet.strings[primary]);parsed[primary]=true;}
            if(fill>=0&&(op==3||op==4||op==5)&&!parsed[fill]){colors[fill]=color(packet.strings[fill]);parsed[fill]=true;}
            if(op==6){int id=(int)numbers[at+13];if(fonts[id]==null)fonts[id]=font(packet.strings[id]);}
            int dash=(int)numbers[at+9];if(dash>0){float[] intervals=new float[dash];for(int j=0;j<dash;j++)intervals[j]=(float)numbers[at+AsterEngine.ScenePacket.HEADER+j];dashes[i]=new DashPathEffect(intervals,0);}
        }
        return new PreparedPacket(packet,background,colors,fonts,dashes);
    }
    // Natural private renderer seam used by the native fixture; public JSON API remains unchanged.
    void renderPacket(Canvas canvas,AsterEngine.ScenePacket packet,int layer,boolean clear)throws JSONException {PreparedPacket prepared=preparePacket(packet);renderPrepared(canvas,prepared,layer,clear);}
    private void renderPrepared(Canvas canvas,PreparedPacket prepared,int layer,boolean clear)throws JSONException {
        AsterEngine.ScenePacket packet=prepared.packet;if(layer<0||layer>=packet.layerCounts.length||packet.layerCounts[layer]<0)throw new JSONException("Cannot render omitted packet layer");if(clear)canvas.drawColor(prepared.background,PorterDuff.Mode.SRC);
        double[] a=packet.numbers;int end=packet.layerStarts[layer]+packet.layerCounts[layer];
        for(int j=packet.layerStarts[layer];j<end;j++){int h=packet.commandStarts[j],op=(int)a[h],start=h+AsterEngine.ScenePacket.HEADER+(int)a[h+9],count=(int)a[h+14],fill=(int)a[h+10];canvas.save();try{
            if(a[h+4]==1)canvas.clipRect((float)a[h+5],(float)a[h+6],(float)(a[h+5]+a[h+7]),(float)(a[h+6]+a[h+8]));
            paint.setColor(prepared.colors[(int)a[h+2]]);paint.setStrokeWidth((float)a[h+3]);paint.setStyle(Paint.Style.STROKE);paint.setPathEffect(prepared.dashes[j]);Path path=new Path();
            if(op==1){for(int i=start;i<start+count;i+=4){path.moveTo((float)a[i],(float)a[i+1]);path.lineTo((float)a[i+2],(float)a[i+3]);}canvas.drawPath(path,paint);}
            else if(op==2){paint.setStyle(Paint.Style.FILL);for(int i=start;i<start+count;i+=4)path.addRect((float)a[i],(float)a[i+1],(float)(a[i]+a[i+2]),(float)(a[i+1]+a[i+3]),Path.Direction.CW);canvas.drawPath(path,paint);}
            else if(op==3&&count>=2){path.moveTo((float)a[start],(float)a[start+1]);for(int i=start+2;i<start+count;i+=2)path.lineTo((float)a[i],(float)a[i+1]);canvas.drawPath(path,paint);if(fill>=0){paint.setStyle(Paint.Style.FILL);paint.setColor(prepared.colors[fill]);path.lineTo((float)a[start+count-2],(float)a[h+11]);path.lineTo((float)a[start],(float)a[h+11]);path.close();canvas.drawPath(path,paint);}}
            else if(op==4||op==5){RectF r=new RectF((float)a[start],(float)a[start+1],(float)(a[start]+a[start+2]),(float)(a[start+1]+a[start+3]));if(fill>=0){paint.setStyle(Paint.Style.FILL);paint.setColor(prepared.colors[fill]);if(op==4)canvas.drawRect(r,paint);else canvas.drawOval(r,paint);}paint.setStyle(Paint.Style.STROKE);paint.setColor(prepared.colors[(int)a[h+2]]);if(op==4)canvas.drawRect(r,paint);else canvas.drawOval(r,paint);}
            else if(op==6){FontSpec font=prepared.fonts[(int)a[h+13]];paint.setStyle(Paint.Style.FILL);paint.setTypeface(font.typeface);paint.setTextSize(font.size);canvas.drawText(packet.strings[(int)a[h+12]],(float)a[start],(float)a[start+1],paint);}
        }finally{canvas.restore();}}
    }
    public void render(Canvas canvas,JSONObject scene) throws JSONException {
        canvas.drawColor(color(scene.getString("background")),PorterDuff.Mode.SRC);renderCommands(canvas,scene.getJSONArray("commands"));
    }
    private void renderCommands(Canvas canvas,JSONArray commands) throws JSONException {
        for(int j=0;j<commands.length();j++){JSONObject c=commands.getJSONObject(j);canvas.save();try{JSONArray clip=c.optJSONArray("clip");if(clip!=null)canvas.clipRect((float)clip.getDouble(0),(float)clip.getDouble(1),(float)(clip.getDouble(0)+clip.getDouble(2)),(float)(clip.getDouble(1)+clip.getDouble(3)));
            paint.setColor(color(c.getString("color")));paint.setStrokeWidth((float)c.optDouble("width",1));paint.setStyle(Paint.Style.STROKE);paint.setPathEffect(null);JSONArray dash=c.optJSONArray("dash");if(dash!=null){float[] intervals=new float[dash.length()];for(int i=0;i<intervals.length;i++)intervals[i]=(float)dash.getDouble(i);paint.setPathEffect(new DashPathEffect(intervals,0));}
            String op=c.getString("op");Path path=new Path();JSONArray a=c.optJSONArray("coords");
            if(op.equals("lines")){for(int i=0;i<a.length();i+=4){path.moveTo((float)a.getDouble(i),(float)a.getDouble(i+1));path.lineTo((float)a.getDouble(i+2),(float)a.getDouble(i+3));}canvas.drawPath(path,paint);}
            else if(op.equals("rects")){paint.setStyle(Paint.Style.FILL);for(int i=0;i<a.length();i+=4)path.addRect((float)a.getDouble(i),(float)a.getDouble(i+1),(float)(a.getDouble(i)+a.getDouble(i+2)),(float)(a.getDouble(i+1)+a.getDouble(i+3)),Path.Direction.CW);canvas.drawPath(path,paint);}
            else if(op.equals("path")){a=c.getJSONArray("points");if(a.length()>=2){path.moveTo((float)a.getDouble(0),(float)a.getDouble(1));for(int i=2;i<a.length();i+=2)path.lineTo((float)a.getDouble(i),(float)a.getDouble(i+1));canvas.drawPath(path,paint);if(!c.isNull("fill")){paint.setStyle(Paint.Style.FILL);paint.setColor(color(c.getString("fill")));path.lineTo((float)a.getDouble(a.length()-2),(float)c.getDouble("baseline"));path.lineTo((float)a.getDouble(0),(float)c.getDouble("baseline"));path.close();canvas.drawPath(path,paint);}}}
            else if(op.equals("box")||op.equals("ellipse")){RectF r=new RectF((float)c.getDouble("x"),(float)c.getDouble("y"),(float)(c.getDouble("x")+c.getDouble("w")),(float)(c.getDouble("y")+c.getDouble("h")));if(!c.isNull("fill")){paint.setStyle(Paint.Style.FILL);paint.setColor(color(c.getString("fill")));if(op.equals("box"))canvas.drawRect(r,paint);else canvas.drawOval(r,paint);}paint.setStyle(Paint.Style.STROKE);paint.setColor(color(c.getString("color")));if(op.equals("box"))canvas.drawRect(r,paint);else canvas.drawOval(r,paint);}
            else if(op.equals("text")){paint.setStyle(Paint.Style.FILL);String font=c.optString("font","12px monospace");java.util.regex.Matcher m=FONT.matcher(font);if(m.matches()){String prefix=m.group(1),family=m.group(3).split(",")[0].trim().replace("\"","").replace("'","");int style=(prefix.contains("bold")?Typeface.BOLD:0)|(prefix.contains("italic")?Typeface.ITALIC:0);paint.setTypeface(Typeface.create(family,style));paint.setTextSize(Float.parseFloat(m.group(2)));}else{paint.setTypeface(Typeface.MONOSPACE);paint.setTextSize(12);}canvas.drawText(c.getString("text"),(float)c.getDouble("x"),(float)c.getDouble("y"),paint);}}finally{canvas.restore();}
        }
    }
    private static final java.util.regex.Pattern FONT=java.util.regex.Pattern.compile("^((?:(?:bold|italic|normal)\\s+)*)([0-9]+(?:\\.[0-9]+)?)px\\s+(.+)$");
}
