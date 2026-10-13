package dev.aster.charts;

import android.content.Context;
import org.json.*;
import java.time.Instant;

/** Genuine public Java SDK -> JNI -> QuickJS Intl shim regression.
 * No production eval, timers, input injection or long-running operation.
 */
final class TimezoneVerification {
    private final JSONArray checks=new JSONArray();
    private int failed;
    interface Test {void run() throws Exception;}
    private void test(String name,Test body){JSONObject row=new JSONObject();try{row.put("check",name);body.run();row.put("passed",true);}catch(Throwable error){failed++;try{row.put("passed",false).put("error",error.toString());}catch(JSONException nested){throw new IllegalStateException(nested);}}checks.put(row);}
    private static void need(boolean ok,String reason){if(!ok)throw new AssertionError(reason);}
    private static JSONObject options()throws JSONException {return new JSONObject().put("panels",new JSONArray().put(new JSONObject().put("id","price"))).put("series",new JSONArray().put(new JSONObject().put("id","price").put("type","candles").put("panel","price")));}
    private static JSONObject symbol(String zone)throws JSONException {return new JSONObject().put("id","TEST").put("exchange","LOCAL").put("timezone",zone).put("currency","USD").put("volumeUnit","shares").put("priceDecimals",2).put("tickSize",0.01).put("adjustment","raw");}
    private static JSONObject bar(String time,double close)throws JSONException {return new JSONObject().put("time",Instant.parse(time).toEpochMilli()).put("open",close).put("high",close+1).put("low",close-1).put("close",close).put("volume",2);}
    private static JSONArray ticks(AsterEngine engine)throws Exception {JSONArray result=new JSONArray(),commands=engine.scene(1200,700).getJSONArray("commands");for(int i=0;i<commands.length();i++){JSONObject c=commands.getJSONObject(i);if(c.optString("role").equals("time-tick"))result.put(c.optString("fullText",c.optString("text")));}need(result.length()>0,"Expected actual timezone-formatted scene time ticks");return result;}
    private void symbolParity(Context context,String mixed,String canonical)throws Exception {
        // mixed context is created and called before the canonical reference.
        try(AsterEngine candidate=new AsterEngine(context,0,options())){
            candidate.setSymbol(symbol(mixed));need(((JSONObject)candidate.command("inspect")).getJSONObject("symbol").getString("timezone").equals(mixed),"Original caller timezone string retained");
            candidate.setData(new JSONArray().put(bar("2026-03-06T14:30:00Z",10)).put(bar("2026-03-09T13:30:00Z",20)));JSONArray actual=ticks(candidate);
            try(AsterEngine reference=new AsterEngine(context,0,options())){reference.setSymbol(symbol(canonical));reference.setData(new JSONArray().put(bar("2026-03-06T14:30:00Z",10)).put(bar("2026-03-09T13:30:00Z",20)));need(actual.toString().equals(ticks(reference).toString()),"Canonical and mixed case scene formatting differs");}
        }
    }
    private void vwapCold(Context context,String zone)throws Exception {
        try(AsterEngine engine=new AsterEngine(context,0,options())){
            // addIndicator calendar validation is the first timezone request in this VM.
            String calendar=new JSONObject().put("timezone",zone).put("weekdays",new JSONArray().put(1).put(2).put(3).put(4).put(5)).put("windows",new JSONArray().put(new JSONObject().put("open","09:30").put("close","16:00").put("kind","regular"))).put("exceptions",new JSONObject()).put("ambiguity","earlier").toString();
            engine.addIndicator("v","vwap",new JSONObject().put("calendar",calendar).put("deviation",2));
            engine.setData(new JSONArray().put(bar("2026-03-06T14:29:00Z",5)).put(bar("2026-03-06T14:30:00Z",10)).put(bar("2026-03-09T13:29:00Z",15)).put(bar("2026-03-09T13:30:00Z",20)));
            JSONArray values=(JSONArray)engine.command("indicatorValues","v","value");need(values.length()==4&&values.isNull(0)&&values.getDouble(1)==10&&values.isNull(2)&&values.getDouble(3)==20,"Literal New York pre/post DST session open/reset");
        }
    }
    private void invalidAtomic(Context context,String zone)throws Exception {
        try(AsterEngine engine=new AsterEngine(context,0,options())){
            engine.setSymbol(symbol("UTC"));String before=((JSONObject)engine.command("inspect")).toString();long rev=engine.revision();boolean rejected=false;
            try{engine.setSymbol(symbol(zone));}catch(RuntimeException error){rejected=true;need(error.getMessage()!=null&&!error.getMessage().isEmpty(),"Explicit invalid timezone error");}
            need(rejected&&rev==engine.revision()&&before.equals(((JSONObject)engine.command("inspect")).toString()),"Invalid timezone silently accepted or changed current model/revision");
        }
    }
    private static String helper(long time,String zone)throws JSONException {return new JSONArray(AsterEngine.zonedParts(time,zone)).toString();}
    JSONObject run(Context context)throws Exception {
        try(AsterEngine witness=new AsterEngine(context,0,options())){
            // Keep the first process-wide Java request mixed, as well as first per-VM request.
            test("SDK cold mixed-case New York symbol and actual time labels",()->symbolParity(context,"aMeRiCa/nEw_YoRk","America/New_York"));
            test("SDK cold mixed-case UTC symbol",()->symbolParity(context,"uTc","UTC"));
            test("SDK cold mixed-case US/Eastern alias",()->symbolParity(context,"uS/eAsTeRn","US/Eastern"));
            test("SDK cold mixed-case Etc/GMT+5 preserves reversed offset",()->symbolParity(context,"eTc/gMt+5","Etc/GMT+5"));
            test("SDK canonical New York remains accepted",()->symbolParity(context,"America/New_York","America/New_York"));
            test("SDK mixed-case VWAP calendar literal DST open",()->vwapCold(context,"aMeRiCa/nEw_YoRk"));
            test("SDK canonical VWAP calendar literal DST open",()->vwapCold(context,"America/New_York"));
            test("SDK invalid identifier rejects atomically",()->invalidAtomic(context,"America/Not_A_Real_Zone"));
            test("SDK whitespace is not trimmed to a valid zone",()->invalidAtomic(context," America/New_York "));
            test("SDK Unicode lookalike is not accepted as ASCII IANA",()->invalidAtomic(context,"Amer\u0131ca/New_York"));
            long dst=Instant.parse("2026-03-09T13:30:00Z").toEpochMilli();
            test("Java helper only mixed-case NY parity",()->need(helper(dst,"aMeRiCa/nEw_YoRk").equals(helper(dst,"America/New_York")),"Java helper mixed NY differs"));
            test("Java helper only mixed-case UTC parity",()->need(helper(dst,"uTc").equals(helper(dst,"UTC")),"Java helper mixed UTC differs"));
            test("Java helper only alias parity",()->need(helper(dst,"uS/eAsTeRn").equals(helper(dst,"US/Eastern")),"Java helper alias differs"));
            test("Java helper only repeated DST wall clock",()->need(helper(Instant.parse("2026-11-01T05:30:00Z").toEpochMilli(),"America/New_York").equals(helper(Instant.parse("2026-11-01T06:30:00Z").toEpochMilli(),"America/New_York")),"Repeated NY01:30 differs"));
            test("Java helper only invalid remains explicit",()->{boolean rejected=false;try{helper(dst,"Not_A_Zone");}catch(java.time.DateTimeException expected){rejected=true;}need(rejected,"Invalid helper zone accepted");});
            test("All test engines closed before witness ledger",()->{JSONObject m=witness.runtimeMetrics();need(m.getLong("processLiveNativeHandles")==1&&m.getLong("processNativeHandlesCreated")-m.getLong("processNativeHandlesFreed")==1,"Native test engines leaked");});
            return new JSONObject().put("passed",failed==0).put("checkCount",checks.length()).put("failed",failed).put("checks",checks).put("runtimeBeforeWitnessClose",witness.runtimeMetrics()).put("api",android.os.Build.VERSION.SDK_INT).put("physicalDevice",false).put("scope","SDK cases run through public AsterEngine->JNI->actualQuickJS Intl shim; Java-helper-only cases are named separately. Fresh VM per SDK case; first process timezone request mixed NY. No direct eval, system input, timers or performance measurement.");
        }
    }
}
