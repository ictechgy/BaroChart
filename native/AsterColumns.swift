import Foundation

/// Six immutable, owned Swift array values. The snapshot retains Array COW
/// storage rather than serializing numeric JSON or eagerly duplicating it.
/// Safe mutations of the caller's array values after construction detach their
/// storage. Unsafe aliased pointers or unsynchronized mutation are unsupported.
/// Shape/count checks are cheap; OHLCV values/order/overflow validate in the
/// isolated preparation VM before publication.
public struct AsterColumns {
    public let time, open, high, low, close, volume: [Double]
    public var length: Int {time.count}
    public var retainedBytes: Int {length * 6 * MemoryLayout<Double>.size}
    public init(time:[Double],open:[Double],high:[Double],low:[Double],close:[Double],volume:[Double]) throws {
        guard time.count <= 4194304,[open.count,high.count,low.count,close.count,volume.count].allSatisfy({$0==time.count}) else {throw AsterAsyncError.invalidProtocol("Equal column lengths <=4194304 required")}
        self.time=time;self.open=open;self.high=high;self.low=low;self.close=close;self.volume=volume
    }
    func field(_ slot:Int) throws -> [Double] {
        switch slot {case 0:return time;case 1:return open;case 2:return high;case 3:return low;case 4:return close;case 5:return volume;default:throw AsterAsyncError.invalidProtocol("Column slot")}
    }
}
