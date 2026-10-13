import Foundation

@main struct IngestionCLI {
    static func main() throws {
        guard CommandLine.arguments.count>=3 else{throw AsterError.javaScript("Usage: ingestion-cli CORE.js REPORT.json [--sync|--async|--codec]")}
        let url=URL(fileURLWithPath:CommandLine.arguments[1]),output=URL(fileURLWithPath:CommandLine.arguments[2]);var report:[String:Any]=["schema":"aster.cycle12.apple-functional"]
        if !CommandLine.arguments.contains("--async") && !CommandLine.arguments.contains("--codec"){report["ingestion"]=try verifyNativeIngestion(url)}
        if !CommandLine.arguments.contains("--async") && !CommandLine.arguments.contains("--sync"){report["codecs"]=try verifyNativeIngestionStudyCodecs(url)}
        if !CommandLine.arguments.contains("--sync") && !CommandLine.arguments.contains("--codec"){
            var finished=false,result:Result<[String:Any],Error>?
            verifyNativeIngestionAsync(url){result=$0;finished=true};let deadline=ProcessInfo.processInfo.systemUptime+90
            while !finished&&ProcessInfo.processInfo.systemUptime<deadline{autoreleasepool{_=RunLoop.main.run(mode:.default,before:Date(timeIntervalSinceNow:0.01))}}
            guard let result=result else{throw AsterError.javaScript("Ingestion async functional timeout")};report["async"]=try result.get()
        }
        let data=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try data.write(to:output);print(output.path)
    }
}
