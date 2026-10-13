import Foundation
let args=CommandLine.arguments
if args.count != 4 {fatalError("profile <bundle.js> <output.json> <clean|instrumented>")}
try labelProfile(bundle:URL(fileURLWithPath:args[1]),output:URL(fileURLWithPath:args[2]),instrumented:args[3]=="instrumented")
