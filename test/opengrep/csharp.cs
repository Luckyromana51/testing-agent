// Examples for the GLV C# rules: "ruleid" lines must be found, "ok" lines must not.
class Repo {
  void Find(string id, SqlConnection conn) {
    // ruleid: glv.cs.sql-injection
    var cmd = new SqlCommand("SELECT * FROM Users WHERE Id = " + id, conn);
    // ok: glv.cs.sql-injection
    var ok = new SqlCommand("SELECT * FROM Users WHERE Id = @id", conn);
    // ruleid: glv.cs.sql-injection
    ok.CommandText = $"SELECT * FROM Users WHERE Name = '{id}'";
  }
  void Client() {
    var handler = new HttpClientHandler();
    // ruleid: glv.cs.tls-verify-off
    handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;
  }
}
