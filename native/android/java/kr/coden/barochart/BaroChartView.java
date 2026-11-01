package kr.coden.barochart;
import android.content.Context;import android.content.res.Configuration;import android.graphics.*;import android.os.*;import android.view.*;import android.view.accessibility.AccessibilityNodeInfo;import org.json.*;

/** Android Canvas/Skia native view consuming the shared renderer-neutral scene. */
public final class BaroChartView extends View {
    /** The engine this view draws and sends input to. The view never closes it. */
    public final BaroChartEngine engine;
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
    /** dispose() 이후 true. 이 뷰는 다시는 엔진을 부르지 않는다 */
    private boolean disposed;
    /** 엔진 변경·종료 리스너를 실제로 등록했으면 true. 등록에 실패한 뷰는 떼어낼 때도 엔진을 부르지 않는다 */
    private boolean subscribed;
    private String baseFont,lastAppliedFont;
    /**
     * 엔진마다 하나인 글꼴 배율 공유 기록(Swift와 같은 계약): 소유 뷰, 배율 전 기준 글꼴, 소유자가 마지막으로 적용한 글꼴.
     * 뷰를 약하게 잡아 값 -> 뷰 -> 엔진 경로가 약한 키(엔진)를 붙잡지 않게 한다. 메인 스레드에서만 읽고 쓴다.
     */
    private static final class FontRecord {
        final java.lang.ref.WeakReference<BaroChartView> owner;final String baseFont,appliedFont;
        FontRecord(BaroChartView owner,String baseFont,String appliedFont){this.owner=new java.lang.ref.WeakReference<>(owner);this.baseFont=baseFont;this.appliedFont=appliedFont;}
    }
    private static final java.util.WeakHashMap<BaroChartEngine,FontRecord> FONT_RECORDS=new java.util.WeakHashMap<>();
    /**
     * Custom accessibility action ids, in order: zoom in, zoom out, clear the crosshair and cancel the current
     * interaction.
     */
    public static final int ACTION_ZOOM_IN=0x41535401,ACTION_ZOOM_OUT=0x41535402,ACTION_CLEAR_CROSSHAIR=0x41535403,ACTION_CANCEL_INTERACTION=0x41535404;
    private String lastError=null;
    private OnChartErrorListener errorListener;
    private Runnable interactionListener;
    /** The engine revision captured after the most recent successful draw. */
    public long renderedRevision=0;
    private final Runnable onChange=()->{if(disposed)return;if(systemFontScaleEnabled&&!applyingFont&&inputDepth==0)try{applySystemFontScale();}catch(Exception error){report(error);}invalidate();};
    private final Runnable onClose=()->{if(disposed)return;engineClosed=true;resetTouch();dropFontRecord();baseFont=lastAppliedFont=null;evictBitmapCache();drawProbe=null;invalidate();};
    interface DrawProbe {void submitted(DrawTiming timing);}
    static final class DrawTiming {
        final long startNanos,submitNanos,canvasNanos,accessibilityNanos;final BaroChartEngine.SceneTiming scene;
        final long baseRasterNanos,drawingRasterNanos,bitmapCopyNanos,hoverNanos,packetPreparationNanos;
        final boolean cacheUsed,baseChanged,drawingsChanged;
        DrawTiming(long start,long submit,long canvas,long accessibility,BaroChartEngine.SceneTiming scene){this(start,submit,canvas,accessibility,scene,0,0,0,0,false,false,false);}
        DrawTiming(long start,long submit,long canvas,long accessibility,BaroChartEngine.SceneTiming scene,long base,long drawings,long bitmap,long hover,boolean cache,boolean baseChanged,boolean drawingsChanged){this(start,submit,canvas,accessibility,scene,base,drawings,bitmap,hover,cache,baseChanged,drawingsChanged,0);}
        DrawTiming(long start,long submit,long canvas,long accessibility,BaroChartEngine.SceneTiming scene,long base,long drawings,long bitmap,long hover,boolean cache,boolean baseChanged,boolean drawingsChanged,long preparation){startNanos=start;submitNanos=submit;canvasNanos=canvas;accessibilityNanos=accessibility;this.scene=scene;baseRasterNanos=base;drawingRasterNanos=drawings;bitmapCopyNanos=bitmap;hoverNanos=hover;cacheUsed=cache;this.baseChanged=baseChanged;this.drawingsChanged=drawingsChanged;packetPreparationNanos=preparation;}
    }
    private DrawProbe drawProbe;
    void setDrawProbe(DrawProbe probe){drawProbe=probe;}
    private static void viewOwner(){if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("Chart View requires main thread");}
    /**
     * Creates a view for an engine. The view listens to the engine while it is attached to a window.
     * @param context the Android context
     * @param engine the engine to draw; the view does not close it
     */
    public BaroChartView(Context context,BaroChartEngine engine){super(context);this.engine=engine;density=getResources().getDisplayMetrics().density;touchSlop=ViewConfiguration.get(context).getScaledTouchSlop();baseBitmapPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC));setFocusable(true);setClickable(true);setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);setContentDescription("Financial chart");}
    private static int color(String s){if(s.matches("#[0-9a-fA-F]{8}"))s="#"+s.substring(7,9)+s.substring(1,7);return Color.parseColor(s);}
    /** 내부 입력 경로(터치·키·hover·크기 변경) 전용: 실패를 던지지 않고 리스너로 보고해 입력 처리 중 앱이 죽지 않게 한다 */
    private void dispatchInput(String name,Object... args){if(disposed)return;inputDepth++;boolean applied=false;try{engine.invoke(name,args);applied=true;}catch(Exception e){report(e);}finally{inputDepth--;invalidate();}if(applied&&interactionListener!=null&&!"nativeResize".equals(name))interactionListener.run();}
    /**
     * Invokes a core input command. Throws {@link BaroChartException} instead of recording a silent failure.
     * @param name core input command name
     * @param args command arguments
     */
    public void fire(String name,Object... args){inputDepth++;try{engine.invoke(name,args);}catch(Exception e){throw BaroChartException.wrap(e);}finally{inputDepth--;invalidate();}}
    /**
     * Configures pointer crosshair snapping. Throws {@link BaroChartException} when the engine rejects the options.
     * @param options snap options as JSON, such as {@code mode}
     */
    public void setCrosshairSnap(JSONObject options){try{engine.setCrosshairSnap(options);lastError=null;}catch(Exception e){throw BaroChartException.wrap(e);}}
    /**
     * Configures the drawing magnet. Throws {@link BaroChartException} when the engine rejects the options.
     * @param options magnet options as JSON, such as {@code mode} and {@code radiusPx}
     */
    public void setDrawingMagnet(JSONObject options){try{engine.setDrawingMagnet(options);lastError=null;}catch(Exception e){throw BaroChartException.wrap(e);}}
    /**
     * Selects a drawing tool by core name. Throws {@link BaroChartException} for unknown tools or a closed engine.
     * @param tool core tool name, see {@link DrawingTool#wireName()}
     */
    public void setTool(String tool){try{engine.setTool(tool);lastError=null;}catch(Exception e){throw BaroChartException.wrap(e);}}
    /**
     * Opt in to system fontScale by updating the engine's logical theme font.
     * Several views may show one engine; the view that enabled scaling last owns it. Taking over keeps the unscaled base
     * font, so the scale is applied once, never on top of an already scaled font. A theme font the app set since the
     * last scaling becomes the new base. Only the owner restores the base font when it disables scaling, is disposed
     * or detaches, and only while the engine font still equals the value it applied; a former owner leaves the font
     * alone. Ignored after {@link #dispose()}.
     * @param enabled true to scale the theme font by the system font scale, false to restore it
     */
    public void setSystemFontScaleEnabled(boolean enabled){viewOwner();if(disposed)return;if(engineClosed)throw new IllegalStateException("Chart engine closed");if(enabled==systemFontScaleEnabled)return;
        if(enabled){FontRecord previous=FONT_RECORDS.get(engine);try{takeOverFontOwner();systemFontScaleEnabled=true;applySystemFontScale();}catch(Exception error){systemFontScaleEnabled=false;restoreFontRecord(previous);baseFont=lastAppliedFont=null;throw new IllegalStateException("Cannot apply system fontScale",error);}}
        else {releaseFontScaling();systemFontScaleEnabled=false;}
        invalidate();
    }
    /**
     * Tells whether system font scaling is enabled for this view. Call on the main thread.
     * @return true when system font scaling is enabled
     */
    public boolean isSystemFontScaleEnabled(){viewOwner();return systemFontScaleEnabled;}
    /** @return 이 뷰가 엔진의 글꼴 배율 소유자이면 true */
    private boolean ownsFont(){FontRecord record=FONT_RECORDS.get(engine);return record!=null&&record.owner.get()==this;}
    /** @return 다른 살아 있는 뷰가 소유자이면 true. 그동안 이 뷰는 배율을 다시 적용하지 않아 배율이 겹치지 않는다 */
    private boolean fontOwnedByOther(){FontRecord record=FONT_RECORDS.get(engine);BaroChartView owner=record==null?null:record.owner.get();return owner!=null&&owner!=this;}
    /**
     * 명시적으로 배율을 켤 때 소유권을 넘겨받는다. 엔진 글꼴이 기록의 적용값 그대로면 기록의 기준 글꼴을 물려받아
     * 원래 기준에서 한 번만 배율을 적용하고, 다르면 앱이 글꼴을 바꾼 것이므로 현재 글꼴을 새 기준으로 삼는다.
     */
    private void takeOverFontOwner()throws JSONException{
        FontRecord record=FONT_RECORDS.get(engine);
        if(record!=null&&record.owner.get()!=this){
            if(themeFont().equals(record.appliedFont)){baseFont=record.baseFont;lastAppliedFont=record.appliedFont;}
            else baseFont=lastAppliedFont=null;
        }
        FONT_RECORDS.put(engine,new FontRecord(this,baseFont,lastAppliedFont));
    }
    /** 켜기에 실패하면 넘겨받기 전 기록으로 되돌려 이전 소유자의 상태를 지킨다 */
    private void restoreFontRecord(FontRecord previous){if(previous!=null)FONT_RECORDS.put(engine,previous);else dropFontRecord();}
    /** 이 뷰가 소유자일 때만 엔진의 기록을 지운다(다른 뷰의 기록은 건드리지 않는다) */
    private void dropFontRecord(){if(ownsFont())FONT_RECORDS.remove(engine);}
    /** 배율을 끄거나 dispose·detach할 때: 소유자만 기준 글꼴을 되돌리고 기록을 지운다. 이전 소유자는 자기 상태만 버린다 */
    private void releaseFontScaling(){if(ownsFont()){restoreSystemFont();dropFontRecord();}baseFont=lastAppliedFont=null;}
    private String themeFont()throws JSONException{return (String)engine.invoke("nativeThemeFont");}
    private void applySystemFontScale()throws JSONException {if(!systemFontScaleEnabled||engineClosed||applyingFont||fontOwnedByOther())return;String current=themeFont();if(lastAppliedFont==null||!current.equals(lastAppliedFont))baseFont=current;
        java.util.regex.Matcher matcher=FONT.matcher(baseFont);if(!matcher.matches())throw new IllegalStateException("Portable theme font required");double scale=Double.parseDouble(Float.toString(getResources().getConfiguration().fontScale));if(!Double.isFinite(scale)||scale<=0)throw new IllegalStateException("Invalid resource fontScale");
        double size=Math.max(4,Math.min(96,Double.parseDouble(matcher.group(2))*scale));String next=matcher.group(1)+java.math.BigDecimal.valueOf(size).stripTrailingZeros().toPlainString()+"px "+matcher.group(3);
        if(!next.equals(current)){cancelTouch();applyingFont=true;try{engine.setTheme(new JSONObject().put("font",next));}finally{applyingFont=false;}}
        lastAppliedFont=next;FONT_RECORDS.put(engine,new FontRecord(this,baseFont,lastAppliedFont));
    }
    private void restoreSystemFont(){if(!engineUsable()||lastAppliedFont==null||baseFont==null)return;try{if(themeFont().equals(lastAppliedFont)&&!baseFont.equals(lastAppliedFont)){cancelTouch();applyingFont=true;try{engine.setTheme(new JSONObject().put("font",baseFont));}finally{applyingFont=false;}}}catch(Exception error){report(error);}}
    @Override protected void onConfigurationChanged(Configuration config){super.onConfigurationChanged(config);if(systemFontScaleEnabled)try{applySystemFontScale();}catch(Exception error){report(error);}invalidate();}
    /**
     * Disable for low-memory clients or direct-render diagnostics.
     * @param enabled true (the default) to cache rendered bitmaps
     */
    public void setRenderCacheEnabled(boolean enabled){viewOwner();if(renderCacheEnabled!=enabled){renderCacheEnabled=enabled;evictBitmapCache();retryAt=0;invalidate();}}
    /**
     * Tells whether the render cache is enabled for this view. Call on the main thread.
     * @return true when the render cache is enabled
     */
    public boolean isRenderCacheEnabled(){viewOwner();return renderCacheEnabled;}
    /**
     * Process-wide CPU bitmap budget. Zero selects direct rendering. Default64MiB.
     * @param bytes budget in bytes; zero selects direct rendering
     */
    public static void setSharedCacheBudgetBytes(long bytes){BaroChartBitmapCachePool.INSTANCE.setBudget(bytes);}
    /**
     * Returns metrics of the process-wide bitmap cache.
     * @return the metrics as JSON
     * @throws JSONException if the metrics cannot be encoded
     */
    public static JSONObject sharedCacheMetrics() throws JSONException {return BaroChartBitmapCachePool.INSTANCE.metrics();}
    /**
     * Returns diagnostic counters of this view's render cache, such as owned bitmap bytes, cache hits, rebuilds and
     * fallbacks. Call on the main thread.
     * @return the counters as JSON
     * @throws JSONException if the counters cannot be encoded
     */
    public JSONObject renderCacheMetrics() throws JSONException {viewOwner();return new JSONObject().put("ownedBitmapBytes",bitmapBytes()).put("cacheHits",cacheHits).put("baseRebuilds",baseRebuilds).put("drawingRebuilds",drawingRebuilds).put("fallbacks",fallbacks).put("failure",cacheFailure==null?JSONObject.NULL:cacheFailure).put("enabled",renderCacheEnabled).put("engineClosed",engineClosed).put("frameCacheCreated",frameCacheCreated).put("packetAttempts",packetAttempts).put("packetFrames",packetFrames).put("legacyFrames",legacyFrames).put("packetFailures",packetFailures).put("packetReleaseFailures",packetReleaseFailures).put("packetNumericBytes",packetNumericBytes).put("packetMetadataChars",packetMetadataChars).put("packetFailure",packetFailure==null?JSONObject.NULL:packetFailure);}
    private long bitmapBytes(){return (baseBitmap==null?0L:baseBitmap.getAllocationByteCount())+(drawingBitmap==null?0L:drawingBitmap.getAllocationByteCount());}
    // Drop Java ownership instead of recycle(): a hardware display list may still use a bitmap.
    void evictBitmapCache(){viewOwner();baseBitmap=null;drawingBitmap=null;BaroChartBitmapCachePool.INSTANCE.release(this);if(frameCacheCreated){frameCacheCreated=false;if(engineUsable())try{engine.releaseFrameCache(frameToken);}catch(Exception releaseFailure){report(releaseFailure);}}retryAt=SystemClock.uptimeMillis()+500;retryPolicyGeneration=BaroChartBitmapCachePool.INSTANCE.generation();invalidate();}
    @Override protected void onAttachedToWindow(){super.onAttachedToWindow();BaroChartBitmapCachePool.INSTANCE.register(getContext());if(!disposed&&!engineClosed)subscribe();}
    /**
     * 엔진 변경·종료를 구독한다. 프레임워크 콜백 안에서 불리므로 절대 던지지 않는다.
     * 닫힌 엔진이나 다른 스레드 소유 엔진이면 리스너로 알리고 구독 없이 비활성으로 남는다(앱 크래시 방지).
     */
    private void subscribe(){
        if(engine.isClosed()){engineClosed=true;report(new BaroChartException(BaroChartException.Code.ENGINE_CLOSED,"The engine was closed before the chart view was attached.","Attach the view to an open engine, or create a new BaroChartEngine.",null));return;}
        try{engine.addChangeListener(onChange);}catch(RuntimeException error){refuseSubscription(error);return;}
        try{engine.addCloseListener(onClose);}catch(RuntimeException error){engine.removeChangeListener(onChange);refuseSubscription(error);return;}
        subscribed=true;
        if(systemFontScaleEnabled)try{applySystemFontScale();}catch(Exception error){report(error);}
    }
    /** 구독 실패를 보고한다. 닫히는 중인 엔진이면 닫힘 상태로 굳혀 입력·그리기가 엔진을 부르지 않게 한다 */
    private void refuseSubscription(RuntimeException error){BaroChartException typed=BaroChartException.wrap(error);if(typed.getCode()==BaroChartException.Code.ENGINE_CLOSED)engineClosed=true;report(typed);}
    /** 등록한 리스너를 뗀다. 등록한 스레드(소유 스레드)에서만 불리므로 스레드 검사에 걸리지 않는다 */
    private void unsubscribe(){subscribed=false;engine.removeChangeListener(onChange);engine.removeCloseListener(onClose);}
    /** 뷰가 아는 한 엔진을 부를 수 있는지: 닫힘 알림을 받았거나 이미 닫힌 엔진이면 false */
    private boolean engineUsable(){return !engineClosed&&!engine.isClosed();}
    /** dispose됐거나 엔진이 닫혀 입력·접근성 동작을 받지 않는 상태 */
    private boolean inert(){return disposed||engineClosed;}
    @Override protected void onSizeChanged(int w,int h,int ow,int oh){if(w!=ow||h!=oh)cancelTouch(true);if(isAttachedToWindow())evictBitmapCache();retryAt=0;dispatchInput("nativeResize",Math.max(100,w/density),Math.max(80,h/density));}
    @Override protected void onDetachedFromWindow(){if(subscribed){cancelTouch(true);unsubscribe();}else resetTouch();releaseFontScaling();drawProbe=null;evictBitmapCache();super.onDetachedFromWindow();}
    @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(!focused)cancelTouch(true);}
    @Override public boolean onHoverEvent(MotionEvent event){if(!disposed&&event.isFromSource(InputDevice.SOURCE_MOUSE)){int action=event.getActionMasked();if(action==MotionEvent.ACTION_HOVER_ENTER||action==MotionEvent.ACTION_HOVER_MOVE)dispatchInput("nativePointer","move",0,event.getX()/density,event.getY()/density);else if(action==MotionEvent.ACTION_HOVER_EXIT)dispatchInput("nativeHoverExit");if(action==MotionEvent.ACTION_HOVER_ENTER||action==MotionEvent.ACTION_HOVER_MOVE||action==MotionEvent.ACTION_HOVER_EXIT)return true;}return super.onHoverEvent(event);}
    private void parentOwnership(boolean owned){if(parentOwned==owned)return;parentOwned=owned;ViewParent parent=getParent();if(parent!=null)parent.requestDisallowInterceptTouchEvent(owned);}
    private void resetTouch(){touching=dragging=drawingTouch=pinchTouch=false;parentOwnership(false);}
    private void cancelTouch(){cancelTouch(false);}
    // Public fire() may have created native input without this View's touch flag.
    private void cancelTouch(boolean force){if((touching||force)&&!engineClosed)dispatchInput("nativePointer","cancel",0,0,0);resetTouch();}
    @Override public boolean onTouchEvent(MotionEvent e){if(inert()||!isEnabled())return false;int action=e.getActionMasked(),i=e.getActionIndex();
        if(action==MotionEvent.ACTION_DOWN){cancelTouch();requestFocus();touching=true;firstPointer=e.getPointerId(i);downX=e.getX(i);downY=e.getY(i);dispatchInput("nativePointer","down",firstPointer+1,downX/density,downY/density,e.getToolType(i)==MotionEvent.TOOL_TYPE_FINGER?24:8);
            try{Object state=engine.invoke("nativeGestureKind");String gesture=state==JSONObject.NULL?"":(String)state;drawingTouch=gesture.equals("edit")||gesture.equals("create");if(gesture.isEmpty()){cancelTouch();return false;}parentOwnership(drawingTouch);}catch(Exception error){report(error);cancelTouch();return false;}
        }else if(action==MotionEvent.ACTION_POINTER_DOWN&&touching){pinchTouch=dragging=true;parentOwnership(true);dispatchInput("nativePointer","down",e.getPointerId(i)+1,e.getX(i)/density,e.getY(i)/density,e.getToolType(i)==MotionEvent.TOOL_TYPE_FINGER?24:8);
        }else if(action==MotionEvent.ACTION_MOVE&&touching){int at=e.findPointerIndex(firstPointer);if(!pinchTouch&&!dragging&&at>=0){float dx=Math.abs(e.getX(at)-downX),dy=Math.abs(e.getY(at)-downY);if(Math.hypot(dx,dy)<=touchSlop&&!drawingTouch)return true;
                if(!drawingTouch&&dy>dx&&getParent()!=null){cancelTouch();return false;}dragging=true;parentOwnership(true);}
            if(dragging)for(int j=0;j<e.getPointerCount();j++)dispatchInput("nativePointer","move",e.getPointerId(j)+1,e.getX(j)/density,e.getY(j)/density);
        }else if((action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_POINTER_UP)&&touching){boolean click=action==MotionEvent.ACTION_UP&&!dragging&&!pinchTouch;
            if(click)dispatchInput("nativePointer","move",0,downX/density,downY/density);dispatchInput("nativePointer","up",e.getPointerId(i)+1,0,0);if(action==MotionEvent.ACTION_UP){resetTouch();if(click)performClick();}
        }else if(action==MotionEvent.ACTION_CANCEL)cancelTouch();return true;
    }
    @Override public boolean performClick(){super.performClick();return true;}
    @Override public void onInitializeAccessibilityNodeInfo(AccessibilityNodeInfo info){super.onInitializeAccessibilityNodeInfo(info);info.setClassName(BaroChartView.class.getName());info.setScrollable(!inert());if(!inert()){info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD);info.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_BACKWARD);info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_ZOOM_IN,"Zoom in"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_ZOOM_OUT,"Zoom out"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_CLEAR_CROSSHAIR,"Clear crosshair"));info.addAction(new AccessibilityNodeInfo.AccessibilityAction(ACTION_CANCEL_INTERACTION,"Cancel interaction"));}}
    @Override public boolean performAccessibilityAction(int action,Bundle args){if(inert()||!isEnabled())return false;try{
        if(action==AccessibilityNodeInfo.ACTION_CLICK){cancelTouch();engine.invoke("nativePointer","move",0,getWidth()/density*.5,getHeight()/density*.35);invalidate();return performClick();}
        if(action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD||action==AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD){cancelTouch();engine.invoke("nativeKey",action==AccessibilityNodeInfo.ACTION_SCROLL_FORWARD?"ArrowRight":"ArrowLeft",true,false);invalidate();return true;}
        if(action==ACTION_ZOOM_IN||action==ACTION_ZOOM_OUT){cancelTouch();engine.command("zoom",action==ACTION_ZOOM_IN?.8:1.25);invalidate();return true;}
        if(action==ACTION_CLEAR_CROSSHAIR){engine.invoke("nativeHoverExit");invalidate();return true;}
        if(action==ACTION_CANCEL_INTERACTION){engine.invoke("nativePointer","cancel",0,0,0);resetTouch();invalidate();return true;}
    }catch(Exception error){report(error);return false;}return super.performAccessibilityAction(action,args);}
    @Override public boolean onKeyDown(int code,KeyEvent event){if(disposed)return super.onKeyDown(code,event);String key;switch(code){case KeyEvent.KEYCODE_DPAD_LEFT:key="ArrowLeft";break;case KeyEvent.KEYCODE_DPAD_RIGHT:key="ArrowRight";break;case KeyEvent.KEYCODE_DPAD_UP:key="ArrowUp";break;case KeyEvent.KEYCODE_DPAD_DOWN:key="ArrowDown";break;case KeyEvent.KEYCODE_PAGE_UP:key="PageUp";break;case KeyEvent.KEYCODE_PAGE_DOWN:key="PageDown";break;case KeyEvent.KEYCODE_DEL:key="Backspace";break;case KeyEvent.KEYCODE_ESCAPE:key="Escape";break;case KeyEvent.KEYCODE_PLUS:case KeyEvent.KEYCODE_EQUALS:key="+";break;case KeyEvent.KEYCODE_MINUS:key="-";break;case KeyEvent.KEYCODE_Z:if(!event.isCtrlPressed())return super.onKeyDown(code,event);key="z";break;default:return super.onKeyDown(code,event);}dispatchInput("nativeKey",key,event.isCtrlPressed(),event.isShiftPressed());return true;}
    private void drawFrame(Canvas canvas) throws JSONException {
        double width=Math.max(100,getWidth()/density),height=Math.max(80,getHeight()/density);long beforeCanvas;
        boolean eligible=renderCacheEnabled&&isAttachedToWindow()&&getWidth()>0&&getHeight()>0;
        boolean retryAllowed=eligible&&(SystemClock.uptimeMillis()>=retryAt||retryPolicyGeneration!=BaroChartBitmapCachePool.INSTANCE.generation());
        if(retryAllowed){
            try{frameCacheCreated=true;PreparedPacket packet=readPacket("frame",width,height,baseBitmap==null);if(packet!=null){beforeCanvas=System.nanoTime();drawCached(canvas,packet);}else{JSONObject frame=engine.renderFrame(frameToken,width,height,baseBitmap==null||packetForceBase);packetForceBase=false;legacyFrames++;beforeCanvas=System.nanoTime();drawCached(canvas,frame);}cacheUsed=true;canvasDuration=System.nanoTime()-beforeCanvas;cacheFailure=null;retryAt=0;return;}
            catch(OutOfMemoryError|RuntimeException|JSONException error){cacheFailure=error.toString();evictBitmapCache();fallbacks++;retryAt=SystemClock.uptimeMillis()+500;retryPolicyGeneration=BaroChartBitmapCachePool.INSTANCE.generation();}
        }
        PreparedPacket packet=readPacket("scene",width,height,false);JSONObject scene=packet==null?engine.scene(width,height):null;if(scene!=null)legacyFrames++;beforeCanvas=System.nanoTime();canvas.save();try{canvas.scale(density,density);if(packet!=null)renderPrepared(canvas,packet,0,true);else render(canvas,scene);}finally{canvas.restore();}canvasDuration=System.nanoTime()-beforeCanvas;
    }
    private PreparedPacket readPacket(String mode,double width,double height,boolean force)throws JSONException {
        if(SystemClock.uptimeMillis()<packetRetryAt)return null;packetAttempts++;long preparation=0;
        try{BaroChartEngine.ScenePacket packet=engine.scenePacket(mode,mode.equals("frame")?frameToken:null,width,height,force);preparation=System.nanoTime();PreparedPacket prepared=preparePacket(packet);packetFrames++;packetNumericBytes+=packet.numbers.length*8L;packetMetadataChars+=engine.sceneTiming().jsonChars;packetRetryAt=0;return prepared;}
        catch(OutOfMemoryError|RuntimeException|JSONException error){packetFailures++;packetFailure=error.toString();packetRetryAt=SystemClock.uptimeMillis()+500;if(mode.equals("frame")){packetForceBase=true;try{engine.releaseFrameCache(frameToken);}catch(RuntimeException|JSONException releaseError){packetReleaseFailures++;packetFailure+="; release: "+releaseError;}}return null;}
        finally{if(preparation!=0)packetPreparationNanos+=System.nanoTime()-preparation;}
    }
    private long canvasDuration;
    private void drawCached(Canvas canvas,JSONObject frame) throws JSONException {
        JSONObject base=frame.optJSONObject("base"),drawings=frame.optJSONObject("drawings"),hover=frame.getJSONObject("hover");
        if(base==null&&baseBitmap==null)throw new JSONException("Frame omitted missing base");
        boolean wantsDrawings=drawings!=null?drawings.getJSONArray("commands").length()>0:drawingBitmap!=null;
        long pixels=(long)getWidth()*getHeight();if(pixels>Long.MAX_VALUE/8)throw new IllegalStateException("Bitmap extent overflow");long estimate=pixels*4*(wantsDrawings?2:1);
        if(!BaroChartBitmapCachePool.INSTANCE.reserve(this,estimate))throw new IllegalStateException("Shared bitmap budget exceeded");
        if(baseBitmap==null){baseBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);baseBitmap.setDensity(Bitmap.DENSITY_NONE);}
        if(wantsDrawings&&drawingBitmap==null){drawingBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);drawingBitmap.setDensity(Bitmap.DENSITY_NONE);}
        if(!wantsDrawings)drawingBitmap=null;
        if(!BaroChartBitmapCachePool.INSTANCE.reserve(this,bitmapBytes()))throw new IllegalStateException("Actual bitmap allocation exceeds shared budget");
        if(base!=null){long before=System.nanoTime();Canvas target=new Canvas(baseBitmap);target.scale(density,density);render(target,base);baseRasterNanos=System.nanoTime()-before;baseRebuilds++;baseChanged=true;}
        else cacheHits++;
        if(drawings!=null){long before=System.nanoTime();if(drawingBitmap!=null){drawingBitmap.eraseColor(Color.TRANSPARENT);Canvas target=new Canvas(drawingBitmap);target.scale(density,density);renderCommands(target,drawings.getJSONArray("commands"));}drawingRasterNanos=System.nanoTime()-before;drawingRebuilds++;drawingsChanged=true;}
        long before=System.nanoTime();canvas.drawBitmap(baseBitmap,0,0,baseBitmapPaint);if(drawingBitmap!=null)canvas.drawBitmap(drawingBitmap,0,0,bitmapPaint);bitmapCopyNanos=System.nanoTime()-before;
        before=System.nanoTime();canvas.save();try{canvas.scale(density,density);renderCommands(canvas,hover.getJSONArray("commands"));}finally{canvas.restore();}hoverNanos=System.nanoTime()-before;BaroChartBitmapCachePool.INSTANCE.touch(this);
    }
    private void drawCached(Canvas canvas,PreparedPacket prepared)throws JSONException {
        BaroChartEngine.ScenePacket frame=prepared.packet;int base=frame.layerCounts[0],drawings=frame.layerCounts[1];
        if(base<0&&baseBitmap==null)throw new JSONException("Packet omitted missing base");boolean wantsDrawings=drawings>=0?drawings>0:drawingBitmap!=null;
        long pixels=(long)getWidth()*getHeight();if(pixels>Long.MAX_VALUE/8)throw new IllegalStateException("Bitmap extent overflow");long estimate=pixels*4*(wantsDrawings?2:1);
        if(!BaroChartBitmapCachePool.INSTANCE.reserve(this,estimate))throw new IllegalStateException("Shared bitmap budget exceeded");
        if(baseBitmap==null){baseBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);baseBitmap.setDensity(Bitmap.DENSITY_NONE);}
        if(wantsDrawings&&drawingBitmap==null){drawingBitmap=Bitmap.createBitmap(getWidth(),getHeight(),Bitmap.Config.ARGB_8888);drawingBitmap.setDensity(Bitmap.DENSITY_NONE);}if(!wantsDrawings)drawingBitmap=null;
        if(!BaroChartBitmapCachePool.INSTANCE.reserve(this,bitmapBytes()))throw new IllegalStateException("Actual bitmap allocation exceeds shared budget");
        if(base>=0){long start=System.nanoTime();Canvas target=new Canvas(baseBitmap);target.scale(density,density);renderPrepared(target,prepared,0,true);baseRasterNanos=System.nanoTime()-start;baseRebuilds++;baseChanged=true;}else cacheHits++;
        if(drawings>=0){long start=System.nanoTime();if(drawingBitmap!=null){drawingBitmap.eraseColor(Color.TRANSPARENT);Canvas target=new Canvas(drawingBitmap);target.scale(density,density);renderPrepared(target,prepared,1,false);}drawingRasterNanos=System.nanoTime()-start;drawingRebuilds++;drawingsChanged=true;}
        long start=System.nanoTime();canvas.drawBitmap(baseBitmap,0,0,baseBitmapPaint);if(drawingBitmap!=null)canvas.drawBitmap(drawingBitmap,0,0,bitmapPaint);bitmapCopyNanos=System.nanoTime()-start;
        start=System.nanoTime();canvas.save();try{canvas.scale(density,density);renderPrepared(canvas,prepared,2,false);}finally{canvas.restore();}hoverNanos=System.nanoTime()-start;BaroChartBitmapCachePool.INSTANCE.touch(this);
    }
    @Override protected void onDraw(Canvas canvas){if(disposed)return;long start=System.nanoTime(),accessibilityNanos=0;super.onDraw(canvas);canvasDuration=baseRasterNanos=drawingRasterNanos=bitmapCopyNanos=hoverNanos=packetPreparationNanos=0;cacheUsed=baseChanged=drawingsChanged=false;
        try{if(engineClosed)throw new IllegalStateException("Chart engine closed");drawFrame(canvas);lastError=null;renderedRevision=engine.revision();long beforeAccessibility=System.nanoTime();String description=(String)engine.invoke("nativeAccessibilityText",true,"android");if(!description.contentEquals(getContentDescription()))setContentDescription(description);accessibilityNanos=System.nanoTime()-beforeAccessibility;}catch(Exception e){report(e);paint.setColor(Color.RED);paint.setTextSize(12);canvas.drawText(lastError,12,30,paint);}
        if(drawProbe!=null&&!engineClosed)drawProbe.submitted(new DrawTiming(start,System.nanoTime(),canvasDuration,accessibilityNanos,engine.sceneTiming(),baseRasterNanos,drawingRasterNanos,bitmapCopyNanos,hoverNanos,cacheUsed,baseChanged,drawingsChanged,packetPreparationNanos));
    }
    private static final class FontSpec {final Typeface typeface;final float size;FontSpec(Typeface typeface,float size){this.typeface=typeface;this.size=size;}}
    private static final class PreparedPacket {
        final BaroChartEngine.ScenePacket packet;final int background;final int[] colors;final FontSpec[] fonts;final DashPathEffect[] dashes;
        PreparedPacket(BaroChartEngine.ScenePacket packet,int background,int[] colors,FontSpec[] fonts,DashPathEffect[] dashes){this.packet=packet;this.background=background;this.colors=colors;this.fonts=fonts;this.dashes=dashes;}
    }
    private static FontSpec font(String value){java.util.regex.Matcher m=FONT.matcher(value);if(m.matches()){String prefix=m.group(1),family=m.group(3).split(",")[0].trim().replace("\"","").replace("'","");int style=(prefix.contains("bold")?Typeface.BOLD:0)|(prefix.contains("italic")?Typeface.ITALIC:0);return new FontSpec(Typeface.create(family,style),Float.parseFloat(m.group(2)));}return new FontSpec(Typeface.MONOSPACE,12);}
    private static PreparedPacket preparePacket(BaroChartEngine.ScenePacket packet){
        int[] colors=new int[packet.strings.length];boolean[] parsed=new boolean[colors.length];FontSpec[] fonts=new FontSpec[colors.length];DashPathEffect[] dashes=new DashPathEffect[packet.commandCount];double[] numbers=packet.numbers;
        int background=color(packet.background);
        for(int i=0;i<packet.commandCount;i++){int at=packet.commandStarts[i],op=(int)numbers[at],primary=(int)numbers[at+2],fill=(int)numbers[at+10];if(!parsed[primary]){colors[primary]=color(packet.strings[primary]);parsed[primary]=true;}
            if(fill>=0&&(op==3||op==4||op==5)&&!parsed[fill]){colors[fill]=color(packet.strings[fill]);parsed[fill]=true;}
            if(op==6){int id=(int)numbers[at+13];if(fonts[id]==null)fonts[id]=font(packet.strings[id]);}
            int dash=(int)numbers[at+9];if(dash>0){float[] intervals=new float[dash];for(int j=0;j<dash;j++)intervals[j]=(float)numbers[at+BaroChartEngine.ScenePacket.HEADER+j];dashes[i]=new DashPathEffect(intervals,0);}
        }
        return new PreparedPacket(packet,background,colors,fonts,dashes);
    }
    // Natural private renderer seam used by the native fixture; public JSON API remains unchanged.
    void renderPacket(Canvas canvas,BaroChartEngine.ScenePacket packet,int layer,boolean clear)throws JSONException {PreparedPacket prepared=preparePacket(packet);renderPrepared(canvas,prepared,layer,clear);}
    private void renderPrepared(Canvas canvas,PreparedPacket prepared,int layer,boolean clear)throws JSONException {
        BaroChartEngine.ScenePacket packet=prepared.packet;if(layer<0||layer>=packet.layerCounts.length||packet.layerCounts[layer]<0)throw new JSONException("Cannot render omitted packet layer");if(clear)canvas.drawColor(prepared.background,PorterDuff.Mode.SRC);
        double[] a=packet.numbers;int end=packet.layerStarts[layer]+packet.layerCounts[layer];
        for(int j=packet.layerStarts[layer];j<end;j++){int h=packet.commandStarts[j],op=(int)a[h],start=h+BaroChartEngine.ScenePacket.HEADER+(int)a[h+9],count=(int)a[h+14],fill=(int)a[h+10];canvas.save();try{
            if(a[h+4]==1)canvas.clipRect((float)a[h+5],(float)a[h+6],(float)(a[h+5]+a[h+7]),(float)(a[h+6]+a[h+8]));
            paint.setColor(prepared.colors[(int)a[h+2]]);paint.setStrokeWidth((float)a[h+3]);paint.setStyle(Paint.Style.STROKE);paint.setPathEffect(prepared.dashes[j]);Path path=new Path();
            if(op==1){for(int i=start;i<start+count;i+=4){path.moveTo((float)a[i],(float)a[i+1]);path.lineTo((float)a[i+2],(float)a[i+3]);}canvas.drawPath(path,paint);}
            else if(op==2){paint.setStyle(Paint.Style.FILL);for(int i=start;i<start+count;i+=4)path.addRect((float)a[i],(float)a[i+1],(float)(a[i]+a[i+2]),(float)(a[i+1]+a[i+3]),Path.Direction.CW);canvas.drawPath(path,paint);}
            else if(op==3&&count>=2){path.moveTo((float)a[start],(float)a[start+1]);for(int i=start+2;i<start+count;i+=2)path.lineTo((float)a[i],(float)a[i+1]);canvas.drawPath(path,paint);if(fill>=0){paint.setStyle(Paint.Style.FILL);paint.setColor(prepared.colors[fill]);path.lineTo((float)a[start+count-2],(float)a[h+11]);path.lineTo((float)a[start],(float)a[h+11]);path.close();canvas.drawPath(path,paint);}}
            else if(op==4||op==5){RectF r=new RectF((float)a[start],(float)a[start+1],(float)(a[start]+a[start+2]),(float)(a[start+1]+a[start+3]));if(fill>=0){paint.setStyle(Paint.Style.FILL);paint.setColor(prepared.colors[fill]);if(op==4)canvas.drawRect(r,paint);else canvas.drawOval(r,paint);}paint.setStyle(Paint.Style.STROKE);paint.setColor(prepared.colors[(int)a[h+2]]);if(op==4)canvas.drawRect(r,paint);else canvas.drawOval(r,paint);}
            else if(op==6){FontSpec font=prepared.fonts[(int)a[h+13]];paint.setStyle(Paint.Style.FILL);paint.setTypeface(font.typeface);paint.setTextSize(font.size);canvas.drawText(packet.strings[(int)a[h+12]],(float)a[start],(float)a[start+1],paint);}
        }finally{canvas.restore();}}
    }
    /**
     * Draws a scene JSON, as returned by {@link BaroChartEngine#scene(double, double)}, onto a canvas.
     * @param canvas the canvas to draw on
     * @param scene the scene as JSON, with {@code background} and {@code commands}
     * @throws JSONException if the scene JSON is malformed
     */
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
    /**
     * Latest failure description recorded by this view, or {@code null} after a successful draw.
     * @return the error description, or {@code null}
     */
    public String getLastError(){return lastError;}
    /**
     * Permanently disconnects this view from its engine. Call on the main thread when the view will not be shown
     * again, for example when its screen is destroyed; Compose {@code BaroChart} calls it when it leaves the
     * composition.
     *
     * <p>Afterwards the view no longer listens to the engine, holds no bitmap caches, ignores touch, key, hover and
     * accessibility input and draws nothing. Its own drawing, input, resize and window callbacks never call the engine
     * again. It never closes the engine, which stays usable by other views. Removing a view from a window, unlike
     * this method, is reversible. Calling it again does nothing. Explicit engine commands sent through this view,
     * such as {@link #setTool(String)} or {@link #fire(String, Object...)}, still reach the engine.</p>
     */
    public void dispose(){
        viewOwner();
        if(disposed)return;
        // 정리 중 터치 취소가 앱의 상호작용 콜백을 부르지 않도록 먼저 뗀다
        interactionListener=null;drawProbe=null;
        if(engineUsable())cancelTouch(subscribed);else resetTouch();
        if(subscribed)unsubscribe();
        releaseFontScaling();systemFontScaleEnabled=false;
        // 프레임 캐시 해제가 엔진을 마지막으로 부를 수 있으므로 disposed 표시보다 먼저 한다
        evictBitmapCache();
        disposed=true;
        invalidate();
    }
    /**
     * Tells whether {@link #dispose()} has run. Call on the main thread.
     * @return true once the view is disposed
     */
    public boolean isDisposed(){viewOwner();return disposed;}
    /**
     * Sets the main-thread listener for failures that cannot be thrown; {@code null} removes it.
     * @param listener the listener, or {@code null} to remove it
     */
    public void setOnChartErrorListener(OnChartErrorListener listener){errorListener=listener;}
    /**
     * Sets a main-thread callback run after touch, key or hover input changes the chart; {@code null} removes it.
     * @param listener the callback, or {@code null} to remove it
     */
    public void setOnInteractionListener(Runnable listener){interactionListener=listener;}
    /** 던질 수 없는 경로의 오류를 lastError에 남기고 리스너로 알린다 */
    private void report(Throwable error){BaroChartException typed=BaroChartException.wrap(error);lastError=typed.toString();if(errorListener!=null)errorListener.onChartError(typed);}
}
