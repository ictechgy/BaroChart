package android.content;

import android.content.res.AssetManager;

/** Test-only compile signature. This is not an Android implementation. */
public abstract class Context {
    public AssetManager getAssets() { throw new UnsupportedOperationException("Compile-only Android stub"); }
}
