package kr.coden.barochart;

import android.app.Activity;
import android.os.Bundle;
import android.widget.FrameLayout;

/**
 * 뷰를 실제 창에 붙였다 떼는 테스트용 액티비티.
 * 창에 붙은 빈 FrameLayout을 두어, 테스트가 차트 뷰를 추가·제거할 때 onAttachedToWindow/onDetachedFromWindow가
 * 그 호출 안에서 동기적으로 일어나게 한다(프레임 콜백에서 터지면 테스트가 아니라 프로세스가 죽는다).
 */
public class TestHostActivity extends Activity {
    /** 차트 뷰를 붙일 컨테이너. onCreate 이후에는 null이 아니다. */
    private FrameLayout container;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        container = new FrameLayout(this);
        setContentView(container);
    }

    /**
     * 창에 붙은 컨테이너. 메인 스레드에서만 쓴다.
     * @return 컨테이너
     */
    FrameLayout container() { return container; }
}
