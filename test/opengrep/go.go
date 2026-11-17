// Examples for the GLV Go rules: "ruleid" lines must be found, "ok" lines must not.
package main

import (
	"crypto/tls"
	"database/sql"
	"fmt"
	"os/exec"
)

func find(db *sql.DB, id string) {
	// ruleid: glv.go.sql-injection
	db.Query(fmt.Sprintf("SELECT * FROM users WHERE id = %s", id))
	// ruleid: glv.go.sql-injection
	db.Exec("DELETE FROM users WHERE id = " + id)
	// ok: glv.go.sql-injection
	db.Query("SELECT * FROM users WHERE id = $1", id)
}

func run(host string) {
	// ruleid: glv.go.command-injection
	exec.Command("sh", "-c", "ping -c 1 "+host).Run()
	// ok: glv.go.command-injection
	exec.Command("ping", "-c", "1", host).Run()
}

func client() *tls.Config {
	// ruleid: glv.go.tls-verify-off
	return &tls.Config{InsecureSkipVerify: true}
}
