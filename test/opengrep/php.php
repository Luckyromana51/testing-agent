<?php
// Examples for the GLV PHP rules: "ruleid" lines must be found, "ok" lines must not.
// ruleid: glv.php.sql-injection
$r = mysqli_query($conn, "SELECT * FROM items WHERE id = " . $_GET['id']);
// ok: glv.php.sql-injection
$r = mysqli_query($conn, "SELECT * FROM items WHERE id = " . intval($_GET['id']));
$stmt = $pdo->prepare("SELECT * FROM items WHERE id = ?");
// ok: glv.php.sql-injection
$stmt->execute([$_GET['id']]);
$name = $_POST['name'];
// ruleid: glv.php.sql-injection
$wpdb->get_results("SELECT * FROM wp_users WHERE name = '$name'");

// ruleid: glv.php.unserialize
$cart = unserialize($_COOKIE['cart']);
// ok: glv.php.unserialize
$cart = json_decode($_COOKIE['cart'], true);

// ruleid: glv.php.command-injection
system("ping -c 1 " . $_GET['host']);
// ok: glv.php.command-injection
system("ping -c 1 " . escapeshellarg($_GET['host']));

// ruleid: glv.php.file-include
include $_GET['page'] . ".php";
// ok: glv.php.file-include
include "header.php";

// ruleid: glv.php.xss
echo "Hello " . $_GET['name'];
// ok: glv.php.xss
echo "Hello " . htmlspecialchars($_GET['name'], ENT_QUOTES);

// ruleid: glv.php.eval
eval($_POST['code']);

// ruleid: glv.php.weak-password-hash
$hash = md5($password);
// ok: glv.php.weak-password-hash
$hash = password_hash($password, PASSWORD_DEFAULT);
// ok: glv.php.weak-password-hash
$key = md5($cacheKey);

// ruleid: glv.php.tls-verify-off
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
