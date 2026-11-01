#if canImport(UIKit)
import UIKit

/// Main-thread UIKit renderer for a borrowed, main-owner engine. Use one
/// interactive view per engine because input state and theme belong to it.
/// Window detach is reversible; dispose permanently disconnects this view.
public final class BaroChartUIView: UIView {
    /// The borrowed engine this view draws. The view never closes it.
    public let engine: BaroChartEngine
    private var pointerIDs: [ObjectIdentifier: Int] = [:]
    private var nextID = 0
    private var inputGeneration: UInt64 = 0
    private var frameRenderer: BaroChartFrameRenderer?
    private var observer: UUID?
    private var notifications: [NSObjectProtocol] = []
    private var contentSizeRegistration: (any UITraitChangeRegistration)?
    private var suspended = false
    private var disposing = false
    private var applyingFont = false
    private var baseFont: String?
    private var lastAppliedFont: String?
    private var lastInputSize: CGSize?
    /// 엔진마다 Dynamic Type 배율을 적용 중인 뷰와 배율 전 원래 글꼴.
    /// 같은 엔진을 새 뷰가 이어받으면(SwiftUI는 새 뷰를 만든 뒤 이전 뷰를 정리한다) 원래 글꼴에서 한 번만 키우고, 소유 뷰만 되돌린다.
    private static var fontScaleRecords: [ObjectIdentifier: FontScaleRecord] = [:]
    private static let fontPattern = try! NSRegularExpression(pattern: "^((?:(?:bold|italic|normal)\\s+)*)([0-9]+(?:\\.[0-9]+)?)px\\s+(.+)$")

    /// Whether the view caches the chart in bitmap layers. Changing it clears the cache and redraws. Defaults to `true`.
    public var layerCachingEnabled = true { didSet {frameRenderer?.release();setNeedsDisplay()} }
    /// Description of the latest failure that could not be thrown, or `nil` after a successful draw.
    public private(set) var lastError: String?
    /// ``BaroChartEngine/revision`` of the engine state drawn last.
    public private(set) var renderedRevision: UInt64 = 0
    /// Whether ``dispose()`` has run. A disposed view ignores input and no longer draws.
    @objc public private(set) var isDisposed = false
    /// Opt in to scaling the caller's logical CSS font with UIFontMetrics.
    /// The original font remains the base; caller replacements reset that base.
    /// Scaling is bounded by the portable core's 4...96 logical-pixel contract.
    @objc public var adjustsFontForContentSizeCategory = false {
        didSet {precondition(Thread.isMainThread);if adjustsFontForContentSizeCategory {synchronizeFont()} else {restoreFont(releaseBase: true)}}
    }
    /// Text style whose Dynamic Type scaling is applied when ``adjustsFontForContentSizeCategory`` is on. Defaults to `.caption1`.
    public var dynamicTypeTextStyle: UIFont.TextStyle = .caption1 {didSet {synchronizeFont()}}
    /// Owner-thread notification after controller input, for external readouts.
    public var onInteraction: (() -> Void)?
    /// Main-thread callback for failures that cannot be thrown to the caller, such as drawing,
    /// touch input, accessibility actions and Dynamic Type updates. `lastError` keeps the latest description.
    public var onError: ((BaroChartError) -> Void)?

    /// Creates a view for `engine`. Main thread only.
    public init(engine: BaroChartEngine, frame: CGRect = .zero) {
        precondition(Thread.isMainThread)
        self.engine = engine
        super.init(frame: frame)
        isMultipleTouchEnabled = true;isOpaque = true;contentMode = .redraw
        accessibilityLabel = "Financial chart";isAccessibilityElement = true
        accessibilityTraits = .adjustable
        accessibilityHint = "Swipe up or down to zoom. Use actions to pan, select drawings, edit or cancel."
        installAccessibilityActions()
    }
    /// Not supported; create the view with ``init(engine:frame:)``.
    public required init?(coder: NSCoder) { return nil }
    deinit {detachResources()}

    /// Idempotent view cleanup. Does not close the borrowed engine. Removing a
    /// view from a window only pauses subscriptions and permits reattachment.
    @objc public func dispose() {
        precondition(Thread.isMainThread)
        guard !isDisposed,!disposing else {return}
        disposing = true;onInteraction = nil
        defer {disposing = false}
        cancelInteraction(clearCrosshair: true)
        detachResources();isDisposed = true;onInteraction = nil
        isUserInteractionEnabled = false;isAccessibilityElement = false
        accessibilityCustomActions = nil;resignFirstResponder()
    }
    private func subscribeEngine() {
        guard observer == nil,!suspended,!isDisposed,!disposing else {return}
        do {try engine.checkFrameOwner();observer = try engine.observeChanges {[weak self] in
            guard let self = self,!self.isDisposed,!self.suspended,!self.disposing else {return}
            self.synchronizeFont();self.setNeedsDisplay()
        }} catch {report(error)}
    }
    private func unsubscribeEngine() {if let observer = observer {try? engine.removeObserver(observer);self.observer = nil}}
    private func attachResources() {
        guard !isDisposed,!disposing,window != nil,notifications.isEmpty else {return}
        suspended = UIApplication.shared.applicationState != .active
        subscribeEngine()
        contentSizeRegistration = registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {(view: BaroChartUIView, _: UITraitCollection) in view.synchronizeFont()}
        let center = NotificationCenter.default
        for name in [UIApplication.willResignActiveNotification,UIApplication.didEnterBackgroundNotification,UIScene.willDeactivateNotification,UIScene.didEnterBackgroundNotification] {
            notifications.append(center.addObserver(forName: name,object: nil,queue: .main) {[weak self] note in
                guard let self = self else {return};if let scene = note.object as? UIScene,scene !== self.window?.windowScene {return};self.suspend()
            })
        }
        for name in [UIApplication.didBecomeActiveNotification,UIScene.didActivateNotification] {
            notifications.append(center.addObserver(forName: name,object: nil,queue: .main) {[weak self] note in
                guard let self = self else {return};if let scene = note.object as? UIScene,scene !== self.window?.windowScene {return};self.resume()
            })
        }
        notifications.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,object: nil,queue: .main) {[weak self] _ in
            guard let self = self else {return};BaroChartNativeCacheBudget.shared.setLimit(0);self.frameRenderer?.release();self.frameRenderer = nil;if !self.suspended {self.setNeedsDisplay()}
        })
        synchronizeFont();setNeedsDisplay()
    }
    private func detachResources() {
        unsubscribeEngine()
        for token in notifications {NotificationCenter.default.removeObserver(token)};notifications.removeAll()
        if let registration = contentSizeRegistration {unregisterForTraitChanges(registration);contentSizeRegistration = nil}
        frameRenderer?.release();frameRenderer = nil
        restoreFont(releaseBase: false)
    }
    private func suspend() {
        guard !suspended,!isDisposed,!disposing else {return}
        cancelInteraction(clearCrosshair: true);suspended = true
        unsubscribeEngine();frameRenderer?.release();frameRenderer = nil
    }
    private func resume() {
        guard !isDisposed,!disposing,window != nil else {return}
        suspended = false;subscribeEngine();synchronizeFont();setNeedsDisplay()
    }
    private func synchronizeFont() {
        guard adjustsFontForContentSizeCategory,!applyingFont,!isDisposed,!disposing,!suspended,window != nil else {return}
        do {
            guard let current = try engine.call("nativeThemeFont").toString() else {throw BaroChartLowLevelError.invalidScene}
            // 다른 뷰가 이 엔진에 배율을 적용해 둔 그대로라면 그 뷰의 원래 글꼴을 넘겨받는다(배율 위에 다시 배율을 얹지 않도록)
            if let record = fontScaleRecord, let owner = record.owner, owner !== self, current == record.applied {
                baseFont = record.base;lastAppliedFont = record.applied
            }
            if current != lastAppliedFont {baseFont = current}
            guard let base = baseFont else {return}
            let text = base as NSString
            guard let match = Self.fontPattern.firstMatch(in: base,range: NSRange(location: 0,length: text.length)),let size = Double(text.substring(with: match.range(at: 2))) else {return}
            let scaledSize = min(96,max(4,Double(UIFontMetrics(forTextStyle: dynamicTypeTextStyle).scaledValue(for: CGFloat(size),compatibleWith: traitCollection))))
            let scaled = NSMutableString(string: base);scaled.replaceCharacters(in: match.range(at: 2),with: String(format: "%.3f",locale: Locale(identifier: "en_US_POSIX"),scaledSize))
            let desired = abs(scaledSize-size)<0.0005 ? base : scaled as String
            if desired == current {lastAppliedFont = desired;recordFontScale(base: base, applied: desired);return}
            cancelInteraction(clearCrosshair: false)
            guard !isDisposed,!disposing else {return}
            applyingFont = true;defer {applyingFont = false}
            let previous = lastAppliedFont;lastAppliedFont = desired
            do {try engine.setTheme(["font": desired])} catch {lastAppliedFont = previous;throw error}
            recordFontScale(base: base, applied: desired)
        } catch {report(error)}
    }
    /// 이 엔진의 배율 기록(다른 엔진이 같은 식별자를 재사용했거나 엔진이 사라진 기록은 무시)
    private var fontScaleRecord: FontScaleRecord? {
        guard let record = Self.fontScaleRecords[ObjectIdentifier(engine)], record.engine === engine else {return nil}
        return record
    }
    /// 이 뷰를 엔진 배율의 소유자로 기록한다(사라진 엔진의 기록은 함께 정리)
    private func recordFontScale(base: String, applied: String) {
        Self.fontScaleRecords = Self.fontScaleRecords.filter {$0.value.engine != nil}
        Self.fontScaleRecords[ObjectIdentifier(engine)] = FontScaleRecord(engine: engine, owner: self, base: base, applied: applied)
    }
    private func restoreFont(releaseBase: Bool) {
        guard !applyingFont else {return}
        let base = baseFont,owned = lastAppliedFont;lastAppliedFont = nil
        if releaseBase {baseFont = nil}
        // 다른 뷰가 배율을 넘겨받았다면 그 뷰가 원래 글꼴을 갖고 있으므로 되돌리지 않는다
        if let record = fontScaleRecord {
            if let owner = record.owner, owner !== self {return}
            Self.fontScaleRecords[ObjectIdentifier(engine)] = nil
        }
        guard let base = base,let owned = owned,base != owned else {return}
        do {if try engine.call("nativeThemeFont").toString() == owned {
            cancelInteraction(clearCrosshair: false)
            applyingFont = true;defer {applyingFont = false};try engine.setTheme(["font": base])
        }} catch {report(error)}
    }
    private func refreshAccessibility() {
        guard !isDisposed else {return}
        do {
            guard let text = try engine.call("nativeAccessibilityText",[true,"uikit"]).toString() else {throw BaroChartLowLevelError.invalidScene}
            accessibilityValue = text
        } catch {report(error)}
    }
    private func installAccessibilityActions() {
        let actions = ["Zoom in","Zoom out","Pan earlier","Pan later","Next drawing","Previous drawing","Undo","Redo","Delete selected drawing","Cancel interaction"]
        accessibilityCustomActions = actions.map {name in UIAccessibilityCustomAction(name: name) {[weak self] _ in self?.performAccessibleAction(name) ?? false}}
    }
    private func performAccessibleAction(_ action: String) -> Bool {
        guard !isDisposed,!disposing,!suspended,window != nil else {return false}
        do {
            switch action {
            case "Zoom in","Zoom out":cancelInteraction(clearCrosshair: false);_ = try engine.command("zoom",[action == "Zoom in" ? 0.8 : 1.25])
            case "Pan earlier","Pan later":
                // Ctrl+arrow always pans, even while a drawing is selected.
                return fire("nativeKey",[action == "Pan earlier" ? "ArrowLeft" : "ArrowRight",true,false])
            case "Cancel interaction":cancelInteraction(clearCrosshair: true,deselect: true);setNeedsDisplay();return true
            default:
                let key = ["Next drawing":"PageDown","Previous drawing":"PageUp","Undo":"z","Redo":"z","Delete selected drawing":"Delete"][action]!
                return fire("nativeKey",[key,action == "Undo" || action == "Redo",action == "Redo"])
            }
            setNeedsDisplay();onInteraction?();return true
        } catch {report(error);return false}
    }
    /// Zooms in (VoiceOver swipe up).
    public override func accessibilityIncrement() {_ = performAccessibleAction("Zoom in")}
    /// Zooms out (VoiceOver swipe down).
    public override func accessibilityDecrement() {_ = performAccessibleAction("Zoom out")}
    /// VoiceOver standard escape (two-finger scrub) cancels the active input session and selection,
    /// matching the "Cancel interaction" custom action. Returns false when the view cannot act.
    public override func accessibilityPerformEscape() -> Bool {performAccessibleAction("Cancel interaction")}
    /// `true` until the view is disposed, so hardware keyboard commands can reach it.
    public override var canBecomeFirstResponder: Bool {!isDisposed && !disposing}
    /// Hardware keyboard commands: arrow keys, plus, minus, escape and backspace (each also with Shift), and Command-Z and Command-Shift-Z for undo and redo. Empty once the view is disposed.
    public override var keyCommands: [UIKeyCommand]? {
        guard !isDisposed,!disposing else {return []}
        return [UIKeyCommand.inputLeftArrow,UIKeyCommand.inputRightArrow,UIKeyCommand.inputUpArrow,UIKeyCommand.inputDownArrow,"+","-","\u{1b}","\u{8}"].flatMap {input in [UIKeyCommand(input: input,modifierFlags: [],action: #selector(chartKey(_:))),UIKeyCommand(input: input,modifierFlags: .shift,action: #selector(chartKey(_:)))]} + [UIKeyCommand(input: "z",modifierFlags: .command,action: #selector(chartKey(_:))),UIKeyCommand(input: "z",modifierFlags: [.command,.shift],action: #selector(chartKey(_:)))]
    }
    @objc private func chartKey(_ command: UIKeyCommand) {let input = command.input ?? "",key = [UIKeyCommand.inputLeftArrow:"ArrowLeft",UIKeyCommand.inputRightArrow:"ArrowRight",UIKeyCommand.inputUpArrow:"ArrowUp",UIKeyCommand.inputDownArrow:"ArrowDown","\u{1b}":"Escape","\u{8}":"Backspace"][input] ?? input;fire("nativeKey",[key,command.modifierFlags.contains(.command),command.modifierFlags.contains(.shift)])}
    @discardableResult private func fire(_ name: String,_ arguments: [Any]) -> Bool {
        guard !isDisposed,!disposing,!suspended,window != nil else {return false}
        do {
            if name == "nativePointer" || name == "nativeKey" {_ = try engine.call("nativeResize",[max(100,bounds.width),max(80,bounds.height)])}
            _ = try engine.call(name,arguments);setNeedsDisplay()
            if name == "nativePointer" || name == "nativeKey" || name == "nativeWheel" {onInteraction?()};return true
        } catch {report(error);return false}
    }
    private func cancelInteraction(clearCrosshair: Bool,deselect: Bool = false) {
        // A callback may cancel while UIKit is dispatching a multi-touch batch.
        // Remaining touches in that same batch no longer own the input session.
        inputGeneration &+= 1
        let ownsInput = window != nil || !pointerIDs.isEmpty
        pointerIDs.removeAll()
        guard !isDisposed,ownsInput else {return}
        do {
            if deselect {_ = try engine.call("nativeKey",["Escape",false,false])}
            else {_ = try engine.call("nativePointer",["cancel",0,0,0]);if clearCrosshair {_ = try engine.call("nativeHoverExit")}}
            onInteraction?()
        } catch {report(error)}
    }
    /// Resizes the chart to the view's bounds (at least 100 by 80 points) and cancels any active input if the size changed.
    public override func layoutSubviews() {
        super.layoutSubviews()
        let size = CGSize(width: max(100,bounds.width),height: max(80,bounds.height))
        if let previous = lastInputSize,previous != size {
            cancelInteraction(clearCrosshair: true);frameRenderer?.release();frameRenderer = nil
        }
        lastInputSize = size;fire("nativeResize",[size.width,size.height])
    }
    /// Draws the engine's current scene, through the cached frame renderer when ``layerCachingEnabled`` is on. Failures are reported through ``onError`` and ``lastError``.
    public override func draw(_ rect: CGRect) {
        guard !isDisposed,!disposing,!suspended,let context = UIGraphicsGetCurrentContext() else {return}
        // 장면을 읽으며 생기는 autorelease 임시 JSValue가 엔진 컨텍스트를 붙잡지 않도록 프레임마다 비운다
        autoreleasepool {drawFrame(in: context)}
    }
    /// 한 프레임을 그린다. 실패는 뷰 밖으로 던지지 않고 오류 콜백으로 보고한다
    private func drawFrame(in context: CGContext) {
        do {
            if layerCachingEnabled {
                if frameRenderer == nil {frameRenderer = BaroChartFrameRenderer(engine: engine)}
                _ = try frameRenderer!.render(width: max(100,bounds.width),height: max(80,bounds.height),scale: Double(contentScaleFactor),in: context)
            } else {let scene = try engine.scene(width: max(100,bounds.width),height: max(80,bounds.height));BaroChartCoreGraphicsRenderer.render(scene,in: context)}
            lastError = nil;renderedRevision = engine.revision;refreshAccessibility()
        } catch {report(error)}
    }
    /// Starts tracking each touch as a pointer for the chart's gestures.
    public override func touchesBegan(_ touches: Set<UITouch>,with event: UIEvent?) {
        guard !isDisposed,!disposing,!suspended else {return};becomeFirstResponder()
        let generation = inputGeneration
        for touch in touches {
            guard !isDisposed,!disposing,!suspended,inputGeneration == generation else {break}
            nextID += 1;pointerIDs[ObjectIdentifier(touch)] = nextID;let p = touch.location(in: self);fire("nativePointer",["down",nextID,p.x,p.y,22])
        }
    }
    /// Forwards moved touches to the chart.
    public override func touchesMoved(_ touches: Set<UITouch>,with event: UIEvent?) {for touch in touches {guard let id = pointerIDs[ObjectIdentifier(touch)] else {continue};let p = touch.location(in: self);fire("nativePointer",["move",id,p.x,p.y])}}
    /// Ends the tracked pointers for these touches.
    public override func touchesEnded(_ touches: Set<UITouch>,with event: UIEvent?) {for touch in touches {if let id = pointerIDs.removeValue(forKey: ObjectIdentifier(touch)) {fire("nativePointer",["up",id,0,0])}}}
    /// Cancels the active input session.
    public override func touchesCancelled(_ touches: Set<UITouch>,with event: UIEvent?) {cancelInteraction(clearCrosshair: false);setNeedsDisplay()}
    /// Cancels input and releases drawing resources when the view leaves its window. Reversible: moving back into a window reattaches.
    public override func willMove(toWindow newWindow: UIWindow?) {if newWindow == nil {cancelInteraction(clearCrosshair: true);detachResources()};super.willMove(toWindow: newWindow)}
    /// Reattaches resources (engine subscription, Dynamic Type observation) when the view enters a window.
    public override func didMoveToWindow() {super.didMoveToWindow();if window != nil {attachResources()}}
    /// Sets crosshair snapping. Throws `BaroChartError` instead of recording a silent failure.
    public func setCrosshairSnap(_ options: [String: Any]) throws {try performViewCommand {try engine.setCrosshairSnap(options)}}
    /// Sets drawing magnet behavior. Throws `BaroChartError` instead of recording a silent failure.
    public func setDrawingMagnet(_ options: [String: Any]) throws {try performViewCommand {try engine.setDrawingMagnet(options)}}
    /// Selects a drawing tool by core name. Throws `BaroChartError` for unknown tools or a closed engine.
    public func setTool(_ tool: String) throws {try performViewCommand {try engine.setTool(tool)}}
    /// 던질 수 없는 경로의 오류를 lastError에 남기고 onError로 알린다
    private func report(_ error: any Error) {
        let typed = BaroChartError.wrap(error)
        lastError = typed.description
        onError?(typed)
    }
    /// 앱이 부르는 뷰 명령: 폐기된 뷰는 무시하고, 실패는 BaroChartError로 던진다
    private func performViewCommand(_ body: () throws -> Void) throws {
        guard !isDisposed,!disposing else {return}
        try BaroChartError.mapping(body)
        setNeedsDisplay()
    }
}

/// 엔진 하나의 Dynamic Type 배율 소유 기록(소유 뷰, 배율 전 원래 글꼴, 소유 뷰가 적용한 글꼴)
@MainActor private final class FontScaleRecord {
    weak var engine: BaroChartEngine?
    weak var owner: BaroChartUIView?
    let base: String
    let applied: String
    init(engine: BaroChartEngine, owner: BaroChartUIView, base: String, applied: String) {
        self.engine = engine;self.owner = owner;self.base = base;self.applied = applied
    }
}
#endif
