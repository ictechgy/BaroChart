package android.content.res;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/** Test-only in-memory asset fixture. This is not an Android AssetManager. */
public final class AssetManager {
    private final byte[] source;
    private final IOException closeFailure;
    public AssetManager(byte[] source){this(source,null);}
    public AssetManager(byte[] source,IOException closeFailure){this.source=source.clone();this.closeFailure=closeFailure;}
    public InputStream open(String name) throws IOException {
        if(!"aster-core.js".equals(name))throw new IOException("Unknown fixture asset");
        final IOException failure=closeFailure;
        return new ByteArrayInputStream(source){@Override public void close() throws IOException {super.close();if(failure!=null)throw failure;}};
    }
}
