# Examples for the GLV Python rules: "ruleid" lines must be found, "ok" lines must not.
import os, pickle, subprocess, hashlib, requests, yaml
from flask import Flask, request, send_file

app = Flask(__name__)

def find(cur, user_id, name):
    # ruleid: glv.py.sql-injection
    cur.execute("SELECT * FROM users WHERE id = %s" % user_id)
    # ruleid: glv.py.sql-injection
    cur.execute(f"SELECT * FROM users WHERE name = '{name}'")
    # ok: glv.py.sql-injection
    cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))

def run(cmd):
    # ruleid: glv.py.command-injection
    subprocess.call(cmd, shell=True)
    # ok: glv.py.command-injection
    subprocess.call(["ls", "-l"])
    # ok: glv.py.command-injection
    subprocess.call("uptime", shell=True)
    # ruleid: glv.py.command-injection
    os.system("rm -rf " + cmd)

def load(f):
    # ruleid: glv.py.unsafe-yaml
    a = yaml.load(f)
    # ok: glv.py.unsafe-yaml
    b = yaml.load(f, Loader=yaml.SafeLoader)
    # ok: glv.py.unsafe-yaml
    c = yaml.safe_load(f)
    # ruleid: glv.py.pickle
    return pickle.loads(f.read())

def fetch(url):
    # ruleid: glv.py.tls-verify-off
    requests.get(url, verify=False)
    # ok: glv.py.tls-verify-off
    requests.get(url, timeout=5)

def calc(expr):
    # ruleid: glv.py.eval
    return eval(expr)

@app.route("/proxy")
def proxy():
    # ruleid: glv.py.ssrf
    return requests.get(request.args.get("url")).text

@app.route("/file")
def file():
    name = request.args["name"]
    # ok: glv.py.path-traversal
    send_file(os.path.basename(name))
    # ruleid: glv.py.path-traversal
    return send_file("uploads/" + name)

def save(password):
    # ruleid: glv.py.weak-password-hash
    return hashlib.md5(password.encode()).hexdigest()

def etag(body):
    # ok: glv.py.weak-password-hash
    return hashlib.md5(body).hexdigest()

if __name__ == "__main__":
    # ruleid: glv.py.debug-on
    app.run(debug=True)
