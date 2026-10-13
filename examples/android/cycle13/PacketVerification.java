package dev.aster.charts;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.Arrays;

/** Private fixture. Decoder guards are separate from genuine QuickJS/Canvas checks. */
public final class PacketVerification {
    private PacketVerification() {}
    private interface Attempt {void run() throws Exception;}
    private static final class Checks {
        final JSONArray rows=new JSONArray();
        void check(boolean value,String label){if(!value)throw new AssertionError(label);rows.put(label);}
        void rejects(Attempt attempt,String label)throws Exception {boolean rejected=false;try{attempt.run();}catch(JSONException|IllegalArgumentException error){rejected=true;}check(rejected,label);}
    }
    private static JSONObject metadata(String mode,JSONArray layers)throws JSONException {
        return new JSONObject().put("schema","aster.native.commands").put("version",1).put("mode",mode).put("width",320).put("height",240).put("background","#101820")
            .put("strings",new JSONArray().put("#00ff00ff").put("#ff000066").put("A\u0000\n\"한글 😀\ud800").put("bold 18px monospace"))
            .put("layers",layers).put("stats",new JSONObject().put("storedBars",512).put("visibleSourceBars",201).put("renderedCandleBuckets",64).put("commandCount",1));
    }
    private static JSONObject sceneMeta()throws JSONException {return metadata("scene",new JSONArray().put(new JSONObject().put("commands",1)));}
    private static double[] record(int op,double... geometry){double[] result=new double[15+geometry.length];result[0]=op;result[1]=result.length;result[2]=0;result[3]=1;result[10]=-1;result[12]=-1;result[13]=-1;result[14]=geometry.length;System.arraycopy(geometry,0,result,15,geometry.length);return result;}
    private static double[] changed(double[] original,int at,double value){double[] copy=original.clone();copy[at]=value;return copy;}
    private static AsterEngine.ScenePacket decode(JSONObject meta,double[] numbers)throws JSONException {return new AsterEngine.ScenePacket(meta.toString(),numbers);}
    public static JSONObject decoder()throws Exception {
        Checks c=new Checks();JSONObject meta=sceneMeta();double[] line=record(1,1.125,2.25,30.5,40.75);
        AsterEngine.ScenePacket packet=decode(meta,line);c.check(packet.commandCount==1&&packet.numbers.length==19,"Valid line packet");c.check(packet.strings[2].equals("A\u0000\n\"한글 😀\ud800"),"Dictionary preserves NUL/control/quotes/Korean/emoji/lone surrogate");
        c.check(Double.doubleToRawLongBits(packet.numbers[15])==Double.doubleToRawLongBits(1.125),"F64 geometry retained before Canvas conversion");
        for(double value:new double[]{Double.NaN,Double.POSITIVE_INFINITY,Double.NEGATIVE_INFINITY})c.rejects(()->decode(meta,changed(line,15,value)),"Reject nonfinite geometry "+value);
        c.rejects(()->decode(meta,changed(line,0,7)),"Unknown operation");c.rejects(()->decode(meta,changed(line,0,1.5)),"Fractional operation");
        c.rejects(()->decode(meta,changed(line,1,18)),"Truncated record length");c.rejects(()->decode(meta,changed(line,1,20)),"Overflow record length");
        c.rejects(()->decode(meta,changed(line,2,-1)),"Missing required color");c.rejects(()->decode(meta,changed(line,2,4)),"Dictionary upper boundary");c.rejects(()->decode(meta,changed(line,2,.5)),"Fractional dictionary index");
        c.rejects(()->decode(meta,changed(line,4,2)),"Clip flag limited to zero/one");c.rejects(()->decode(meta,changed(line,9,-1)),"Negative dash count");c.rejects(()->decode(meta,changed(line,9,1)),"Dash arity");
        c.rejects(()->decode(meta,changed(line,10,-2)),"Fill sentinel limited to -1");c.rejects(()->decode(meta,changed(line,14,3)),"Line arity");
        c.rejects(()->decode(meta,Arrays.copyOf(line,line.length+1)),"Trailing numeric data");c.rejects(()->decode(meta,Arrays.copyOf(line,line.length-1)),"Truncated numeric data");
        c.rejects(()->decode(new JSONObject(meta.toString()).put("version",2),line),"Unsupported version");c.rejects(()->decode(new JSONObject(meta.toString()).put("schema","other"),line),"Unsupported schema");
        c.rejects(()->decode(new JSONObject(meta.toString()).put("mode","other"),line),"Unknown mode");
        c.rejects(()->decode(new JSONObject(meta.toString()).put("layers",new JSONArray()),line),"Scene requires one layer");
        c.rejects(()->decode(new JSONObject(meta.toString()).put("layers",new JSONArray().put(JSONObject.NULL)),line),"Full scene layer cannot be omitted");
        c.rejects(()->decode(new JSONObject(meta.toString()).put("layers",new JSONArray().put(new JSONObject().put("commands",2))),line),"Declared command count must match records");
        c.rejects(()->decode(new JSONObject(meta.toString()).put("layers",new JSONArray().put(new JSONObject().put("commands",.5))),line),"Fractional layer count");
        c.rejects(()->new AsterEngine.ScenePacket(meta.toString()+" trailing",line),"Metadata trailing framing");
        char[] large=new char[1048577];Arrays.fill(large,' ');c.rejects(()->new AsterEngine.ScenePacket(new String(large),line),"Metadata character budget");
        char[] multi=new char[350000];Arrays.fill(multi,'한');c.rejects(()->decode(new JSONObject(meta.toString()).put("padding",new String(multi)),line),"Metadata UTF8 budget differs from character count");
        c.rejects(()->decode(meta,new double[AsterEngine.ScenePacket.MAX_NUMBERS+1]),"Numeric byte budget");
        JSONObject frame=metadata("frame",new JSONArray().put(JSONObject.NULL).put(new JSONObject().put("commands",0)).put(new JSONObject().put("commands",0)));
        AsterEngine.ScenePacket empty=decode(frame,new double[0]);c.check(empty.layerCounts[0]==-1&&empty.layerCounts[1]==0&&empty.layerCounts[2]==0,"Omitted base differs from empty drawings/hover");
        c.rejects(()->decode(metadata("frame",new JSONArray().put(JSONObject.NULL).put(JSONObject.NULL).put(JSONObject.NULL)),new double[0]),"Frame hover cannot be omitted");
        for(int op:new int[]{2,3,4,5,6}){double[] r=record(op,2,3,20,30);if(op==6){r=record(op,20,30);r[12]=2;r[13]=3;}decode(meta,r);c.check(true,"Decode operation "+op);}
        double[] text=record(6,20,30);c.rejects(()->decode(meta,text),"Text requires text/font dictionary indices");
        return new JSONObject().put("passed",true).put("checks",c.rows).put("scope","Pure Java decoder on Android; no QuickJS or device-input claim");
    }
    private static JSONObject legacyCommand(String op,JSONArray coords)throws JSONException {JSONObject result=new JSONObject().put("op",op).put("color","#00ff00ff").put("width",1).put("clip",JSONObject.NULL).put("dash",JSONObject.NULL);if(coords!=null)result.put(op.equals("path")?"points":"coords",coords);return result;}
    /** All opcode/clip/dash/fill/font raster parity; called on owner main thread. */
    public static JSONObject pixels(Context context)throws Exception {
        Checks c=new Checks();AsterEngine engine=new AsterEngine(context,0);try{
            AsterChartView view=new AsterChartView(context,engine);JSONArray commands=new JSONArray();java.util.ArrayList<double[]> records=new java.util.ArrayList<>();
            commands.put(legacyCommand("lines",new JSONArray(new double[]{10,12,140,30})));records.add(record(1,10,12,140,30));
            commands.put(legacyCommand("rects",new JSONArray(new double[]{10,45,20,30})));records.add(record(2,10,45,20,30));
            JSONObject area=legacyCommand("path",new JSONArray(new double[]{50,80,80,60,100,90})).put("fill","#ff000066").put("baseline",110);commands.put(area);double[] ar=record(3,50,80,80,60,100,90);ar[10]=1;ar[11]=110;records.add(ar);
            for(int op:new int[]{4,5}){commands.put(legacyCommand(op==4?"box":"ellipse",null).put("x",op==4?120:180).put("y",50).put("w",35).put("h",30).put("fill","#ff000066"));double[] r=record(op,op==4?120:180,50,35,30);r[10]=1;records.add(r);}
            commands.put(legacyCommand("text",null).put("x",15).put("y",150).put("text","A\u0000\n\"한글 😀\ud800").put("font","bold 18px monospace"));double[] text=record(6,15,150);text[12]=2;text[13]=3;records.add(text);
            JSONObject dashed=legacyCommand("lines",new JSONArray(new double[]{15,175,250,175})).put("clip",new JSONArray(new double[]{20,160,150,25})).put("dash",new JSONArray(new double[]{4,4}));commands.put(dashed);double[] dash=new double[21];System.arraycopy(record(1,15,175,250,175),0,dash,0,15);dash[1]=21;dash[4]=1;dash[5]=20;dash[6]=160;dash[7]=150;dash[8]=25;dash[9]=2;dash[15]=4;dash[16]=4;dash[17]=15;dash[18]=175;dash[19]=250;dash[20]=175;records.add(dash);
            int size=0;for(double[] r:records)size+=r.length;double[] numbers=new double[size];int at=0;for(double[] r:records){System.arraycopy(r,0,numbers,at,r.length);at+=r.length;}
            JSONObject meta=sceneMeta();meta.getJSONArray("layers").getJSONObject(0).put("commands",records.size());AsterEngine.ScenePacket packet=decode(meta,numbers);
            Bitmap legacy=Bitmap.createBitmap(320,240,Bitmap.Config.ARGB_8888),typed=Bitmap.createBitmap(320,240,Bitmap.Config.ARGB_8888);try{
                view.render(new Canvas(legacy),new JSONObject().put("background","#101820").put("commands",commands));view.renderPacket(new Canvas(typed),packet,0,true);
                int[] a=new int[320*240],b=new int[a.length];legacy.getPixels(a,0,320,0,0,320,240);typed.getPixels(b,0,320,0,0,320,240);c.check(Arrays.equals(a,b),"Exact pixel parity all six opcodes/clip/dash/area-fill/text-font");
                int before=typed.getPixel(0,0);boolean rejected=false;try{view.renderPacket(new Canvas(typed),decode(meta,changed(numbers,2,99)),0,true);}catch(JSONException|IllegalArgumentException error){rejected=true;}c.check(rejected&&typed.getPixel(0,0)==before,"Invalid packet rejected before Canvas writes");
                rejected=false;try{view.renderPacket(new Canvas(typed),decode(meta,changed(numbers,2,2)),0,true);}catch(IllegalArgumentException error){rejected=true;}c.check(rejected&&typed.getPixel(0,0)==before,"Color preparation failure precedes background/Canvas writes");
            }finally{legacy.recycle();typed.recycle();}
            AsterEngine.ScenePacket genuine=engine.scenePacket("scene",null,320,240,false);c.check(genuine.layerCounts.length==1,"Genuine QuickJS private packet");c.check(engine.scene(320,240).getJSONArray("commands").length()==genuine.commandCount,"Public scene remains available and command count agrees");
            long revision=engine.revision();engine.scenePacket("scene",null,320,240,false);c.check(engine.revision()==revision,"Private transport is revision readonly");
            java.util.concurrent.atomic.AtomicBoolean wrongOwner=new java.util.concurrent.atomic.AtomicBoolean();Thread other=new Thread(()->{try{engine.scenePacket("scene",null,320,240,false);}catch(IllegalStateException expected){wrongOwner.set(true);}catch(JSONException unexpected){throw new AssertionError(unexpected);}},"packet-wrong-owner");other.start();other.join();c.check(wrongOwner.get(),"Private transport retains owner-thread check");
            return new JSONObject().put("passed",true).put("checks",c.rows).put("scope","Actual QuickJS JNI plus Android software Canvas pixels; physical display/FPS not measured");
        }finally{engine.close();}
    }
}
