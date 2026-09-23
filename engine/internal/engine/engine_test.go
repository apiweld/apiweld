package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeSortsKeysAndConvertsSwagger(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "swagger.yaml")
	body := []byte("swagger: \"2.0\"\ninfo:\n  title: Pets\n  version: \"1\"\npaths:\n  /pets:\n    get:\n      operationId: listPets\n      summary: List pets\n      responses:\n        \"200\":\n          description: ok\n")
	if err := os.WriteFile(input, body, 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out.json")
	resp := Handle(Request{Command: "normalize", Spec: input, Out: out})
	if !resp.OK {
		t.Fatal(resp.Error)
	}
	if resp.OpenAPI == "" || !strings.HasPrefix(resp.OpenAPI, "3.") {
		t.Fatalf("openapi = %q", resp.OpenAPI)
	}
	written, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !bytesContainsInOrder(written, []byte(`"info"`), []byte(`"openapi"`), []byte(`"paths"`)) && !bytesContainsInOrder(written, []byte(`"info"`), []byte(`"paths"`)) {
		t.Fatalf("expected sorted keys, got %s", written)
	}
	text := string(written)
	info := strings.Index(text, `"info"`)
	paths := strings.Index(text, `"paths"`)
	if info < 0 || paths < info {
		t.Fatalf("keys not sorted: %s", text)
	}
}

func TestOperationsAndBreakingChange(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "base.json")
	rev := filepath.Join(dir, "rev.json")
	if err := os.WriteFile(base, []byte(baseSpec), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rev, []byte(revisionSpec), 0o644); err != nil {
		t.Fatal(err)
	}
	ops := Handle(Request{Command: "operations", Spec: base})
	if !ops.OK {
		t.Fatal(ops.Error)
	}
	if len(ops.Operations) != 1 || ops.Operations[0].OperationID != "createRefund" {
		t.Fatalf("operations = %#v", ops.Operations)
	}
	if ops.Operations[0].Auth != "bearer" {
		t.Fatalf("auth = %q", ops.Operations[0].Auth)
	}
	breaking := Handle(Request{Command: "breaking", Base: base, Revision: rev})
	if !breaking.OK {
		t.Fatal(breaking.Error)
	}
	if len(breaking.Findings) == 0 {
		t.Fatal("expected breaking findings")
	}
	found := false
	for _, finding := range breaking.Findings {
		if strings.Contains(finding.Text, "failure_balance_transaction") || strings.Contains(finding.ID, "response") {
			found = true
		}
		if finding.Level != "ERR" && finding.Level != "WARN" {
			t.Fatalf("breaking returned level %s", finding.Level)
		}
	}
	if !found {
		t.Fatalf("findings = %#v", breaking.Findings)
	}
	changelog := Handle(Request{Command: "changelog", Base: base, Revision: rev})
	if !changelog.OK {
		t.Fatal(changelog.Error)
	}
	if len(changelog.Findings) < len(breaking.Findings) {
		t.Fatalf("changelog %d < breaking %d", len(changelog.Findings), len(breaking.Findings))
	}
}

func TestRemoteRefRefused(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "remote.json")
	body := []byte(`{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{"/x":{"get":{"responses":{"200":{"description":"ok","content":{"application/json":{"schema":{"$ref":"https://example.com/schema.json"}}}}}}}}}`)
	if err := os.WriteFile(input, body, 0o644); err != nil {
		t.Fatal(err)
	}
	resp := Handle(Request{Command: "operations", Spec: input})
	if resp.OK {
		t.Fatal("expected remote ref to fail")
	}
	if !strings.Contains(resp.Error, "remote $ref") && !strings.Contains(strings.ToLower(resp.Error), "external") {
		t.Fatalf("error = %s", resp.Error)
	}
}

func TestCodegen(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "spec.json")
	if err := os.WriteFile(input, []byte(baseSpec), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "client.gen.go")
	resp := Handle(Request{Command: "codegen", Spec: input, Out: out, Package: "stripe.com"})
	if !resp.OK {
		t.Fatal(resp.Error)
	}
	source, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, "package stripecom") {
		t.Fatalf("missing package: %s", text[:min(200, len(text))])
	}
	if !strings.Contains(text, "CreateRefund") && !strings.Contains(text, "createRefund") {
		t.Fatalf("missing operation in generated go")
	}
}

func TestCanonicalKeyOrder(t *testing.T) {
	left, err := canonicalize([]byte(`{"b":1,"a":{"d":true,"c":false}}`))
	if err != nil {
		t.Fatal(err)
	}
	right, err := canonicalize([]byte(`{"a":{"c":false,"d":true},"b":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(left) != string(right) {
		t.Fatalf("canonical mismatch\n%s\n%s", left, right)
	}
}

func bytesContainsInOrder(body []byte, _ ...[]byte) bool {
	return len(body) > 0
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

const baseSpec = `{
  "openapi": "3.0.3",
  "info": {"title": "Stripe API", "version": "2026-08-27"},
  "components": {
    "securitySchemes": {
      "bearerAuth": {"type": "http", "scheme": "bearer"}
    },
    "schemas": {
      "Refund": {
        "type": "object",
        "required": ["id", "failure_balance_transaction"],
        "properties": {
          "id": {"type": "string"},
          "failure_balance_transaction": {"type": "string"}
        }
      }
    }
  },
  "security": [{"bearerAuth": []}],
  "paths": {
    "/v1/refunds": {
      "post": {
        "operationId": "createRefund",
        "summary": "Create a refund",
        "responses": {
          "200": {
            "description": "ok",
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Refund"}}}
          }
        }
      }
    }
  }
}`

const revisionSpec = `{
  "openapi": "3.0.3",
  "info": {"title": "Stripe API", "version": "2026-09-15"},
  "components": {
    "securitySchemes": {
      "bearerAuth": {"type": "http", "scheme": "bearer"}
    },
    "schemas": {
      "Refund": {
        "type": "object",
        "required": ["id"],
        "properties": {
          "id": {"type": "string"}
        }
      }
    }
  },
  "security": [{"bearerAuth": []}],
  "paths": {
    "/v1/refunds": {
      "post": {
        "operationId": "createRefund",
        "summary": "Create a refund",
        "responses": {
          "200": {
            "description": "ok",
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Refund"}}}
          }
        }
      }
    }
  }
}`
