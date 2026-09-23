package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/getkin/kin-openapi/openapi2"
	"github.com/getkin/kin-openapi/openapi2conv"
	"github.com/getkin/kin-openapi/openapi3"
	"gopkg.in/yaml.v3"
)

// loadNormalized reads a JSON or YAML spec, converts Swagger 2.0 to OpenAPI 3,
// and refuses remote $refs. The engine never opens a network connection.
func loadNormalized(path string) (*openapi3.T, []byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	return normalizeBytes(raw, path)
}

func normalizeBytes(raw []byte, path string) (*openapi3.T, []byte, error) {
	probe, err := probeDocument(raw)
	if err != nil {
		return nil, nil, err
	}
	var spec *openapi3.T
	if fmt.Sprint(probe["swagger"]) == "2.0" {
		spec, err = convertSwagger2(raw)
		if err != nil {
			return nil, nil, err
		}
	} else {
		loader := newLoader(path)
		parsed, loadErr := loader.LoadFromFile(path)
		if loadErr != nil {
			return nil, nil, loadErr
		}
		spec = parsed
	}
	if spec == nil {
		return nil, nil, fmt.Errorf("empty spec: %s", path)
	}
	encoded, err := spec.MarshalJSON()
	if err != nil {
		return nil, nil, err
	}
	canonical, err := canonicalize(encoded)
	if err != nil {
		return nil, nil, err
	}
	return spec, canonical, nil
}

func probeDocument(raw []byte) (map[string]any, error) {
	var probe map[string]any
	if json.Unmarshal(raw, &probe) == nil && probe != nil {
		return probe, nil
	}
	probe = map[string]any{}
	if err := yaml.Unmarshal(raw, &probe); err != nil {
		return nil, fmt.Errorf("spec is not JSON or YAML: %w", err)
	}
	return probe, nil
}

func convertSwagger2(raw []byte) (*openapi3.T, error) {
	asJSON := raw
	if json.Valid(raw) == false {
		var node any
		if err := yaml.Unmarshal(raw, &node); err != nil {
			return nil, err
		}
		converted, err := json.Marshal(node)
		if err != nil {
			return nil, err
		}
		asJSON = converted
	}
	var doc openapi2.T
	if err := doc.UnmarshalJSON(asJSON); err != nil {
		return nil, fmt.Errorf("parse swagger 2.0: %w", err)
	}
	spec, err := openapi2conv.ToV3(&doc)
	if err != nil {
		return nil, fmt.Errorf("convert swagger 2.0: %w", err)
	}
	return spec, nil
}

func newLoader(specPath string) *openapi3.Loader {
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = true
	loader.ReadFromURIFunc = func(_ *openapi3.Loader, location *url.URL) ([]byte, error) {
		if location == nil {
			return nil, fmt.Errorf("missing $ref location")
		}
		switch strings.ToLower(location.Scheme) {
		case "http", "https":
			return nil, fmt.Errorf("remote $ref %s refused; the engine does not fetch remote references", location.String())
		case "", "file":
			target := location.Path
			if target == "" {
				target = location.Opaque
			}
			body, err := os.ReadFile(target)
			if err != nil {
				return nil, fmt.Errorf("read local $ref %s (from %s): %w", location.String(), specPath, err)
			}
			return body, nil
		default:
			return nil, fmt.Errorf("unsupported $ref scheme %q", location.Scheme)
		}
	}
	return loader
}

func writeCanonical(path string, canonical []byte) error {
	if !bytes.HasSuffix(canonical, []byte("\n")) {
		canonical = append(canonical, '\n')
	}
	return os.WriteFile(path, canonical, 0o644)
}
