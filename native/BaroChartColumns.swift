import Foundation

/// Six immutable, owned Swift array values. The snapshot retains Array COW
/// storage rather than serializing numeric JSON or eagerly duplicating it.
/// Safe mutations of the caller's array values after construction detach their
/// storage. Unsafe aliased pointers or unsynchronized mutation are unsupported.
/// Shape/count checks are cheap; OHLCV values/order/overflow validate in the
/// isolated preparation VM before publication.
public struct BaroChartColumns {
    /// The six columns: time (UTC epoch milliseconds), open, high, low, close and volume. All have the same length.
    public let time, open, high, low, close, volume: [Double]
    /// Number of bars (rows) in the snapshot.
    public var length: Int {time.count}
    /// Logical bytes the six columns retain, not a process footprint.
    public var retainedBytes: Int {length * 6 * MemoryLayout<Double>.size}
    /// Creates a snapshot from six equal-length columns.
    ///
    /// - Throws: ``BaroChartAsyncError`` when the columns differ in length or exceed 4,194,304 rows. Values are validated later, before the data is published.
    public init(time:[Double],open:[Double],high:[Double],low:[Double],close:[Double],volume:[Double]) throws {
        guard time.count <= 4194304,[open.count,high.count,low.count,close.count,volume.count].allSatisfy({$0==time.count}) else {throw BaroChartAsyncError.invalidProtocol("Equal column lengths <=4194304 required")}
        self.time=time;self.open=open;self.high=high;self.low=low;self.close=close;self.volume=volume
    }
    func field(_ slot:Int) throws -> [Double] {
        switch slot {case 0:return time;case 1:return open;case 2:return high;case 3:return low;case 4:return close;case 5:return volume;default:throw BaroChartAsyncError.invalidProtocol("Column slot")}
    }
}
