// Examples for the GLV Java rules: "ruleid" lines must be found, "ok" lines must not.
import java.sql.*;
import javax.crypto.Cipher;

class Repo {
  void find(Statement st, Connection conn, String id) throws Exception {
    // ruleid: glv.java.sql-injection
    st.executeQuery("SELECT * FROM users WHERE id = " + id);
    // ok: glv.java.sql-injection
    PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE id = ?");
    // ok: glv.java.sql-injection
    st.executeQuery("SELECT 1");
  }

  void run(String host) throws Exception {
    // ruleid: glv.java.command-injection
    Runtime.getRuntime().exec("ping -c 1 " + host);
    // ok: glv.java.command-injection
    Runtime.getRuntime().exec("uptime");
  }

  Object read(java.io.InputStream in) throws Exception {
    // ruleid: glv.java.unsafe-deserialize
    return new java.io.ObjectInputStream(in).readObject();
  }

  void crypto() throws Exception {
    // ruleid: glv.java.weak-cipher
    Cipher a = Cipher.getInstance("DES");
    // ruleid: glv.java.weak-cipher
    Cipher b = Cipher.getInstance("AES/ECB/PKCS5Padding");
    // ok: glv.java.weak-cipher
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
  }
}

class TrustAll implements javax.net.ssl.X509TrustManager {
  public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {}
  // ruleid: glv.java.trust-all-certs
  public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {}
  public java.security.cert.X509Certificate[] getAcceptedIssuers() { return null; }
}
