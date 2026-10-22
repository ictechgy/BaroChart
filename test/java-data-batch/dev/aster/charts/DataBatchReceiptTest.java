package dev.aster.charts;
import org.json.JSONException;
/** Executes only the production nested decoder. Never constructs/initializes Engine. */
public final class DataBatchReceiptTest {
    private static int checks;
    private DataBatchReceiptTest() {}
    private static Object[] valid(){return new Object[]{1,3,3,true,true,1,0,0,1,3,4,16,1536};}
    private static void yes(boolean value){checks++;if(!value)throw new AssertionError("decoder expectation");}
    private static void reject(Object schema,Object[] values) throws JSONException {
        try{AsterEngine.DataBatchReceipt.unchanged(schema,values);throw new AssertionError("accepted malformed receipt");}catch(JSONException expected){checks++;}
    }
    public static void main(String[] ignored) throws JSONException {
        yes(AsterEngine.DataBatchReceipt.unchanged("aster.native-data-batch",valid()));
        Object[] changed=valid();changed[2]=5;changed[3]=false;changed[4]=false;changed[9]=4;
        yes(!AsterEngine.DataBatchReceipt.unchanged("aster.native-data-batch",changed));
        reject("other",valid());reject(null,valid());reject("aster.native-data-batch",new Object[0]);
        for(int field:new int[]{0,1,2,5,6,7,8,9,10,11,12})for(Object invalid:new Object[]{null,"0",true,Double.NaN,Double.POSITIVE_INFINITY,-1,0.5}){Object[] row=valid();row[field]=invalid;reject("aster.native-data-batch",row);}
        for(int field:new int[]{3,4})for(Object invalid:new Object[]{null,"true",1,0,Double.NaN}){Object[] row=valid();row[field]=invalid;reject("aster.native-data-batch",row);}
        for(Object[] change:new Object[][]{{0,0},{2,4},{3,false},{5,0},{5,4097},{6,1},{7,1},{8,5},{9,4},{10,0},{11,3},{11,8388608},{12,0}}){Object[] row=valid();row[(Integer)change[0]]=change[1];reject("aster.native-data-batch",row);}
        System.out.println("PASS checks="+checks+" scope=production-data-batch-decoder-only");
    }
}
