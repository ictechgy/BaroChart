package android.content;

import android.content.res.AssetManager;

/** Test-only context signature. This is not an Android runtime Context. */
public abstract class Context {
    public abstract AssetManager getAssets();
}
