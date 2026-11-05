# HTTP protocol test certificates

The self-signed localhost certificate and public test-only private key in this directory are fixtures for local HTTP/1.1 and HTTP/2 negotiation tests. They are not production credentials. Tests temporarily trust the certificate without disabling TLS verification.

Regenerate both files together if they expire:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout server-key.pem -out server-cert.pem -days 3650 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
```
