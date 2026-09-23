package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
)

const version = "0.4.0"

// Request is one JSON document read from stdin.
type Request struct {
	Command  string `json:"command"`
	Spec     string `json:"spec,omitempty"`
	Base     string `json:"base,omitempty"`
	Revision string `json:"revision,omitempty"`
	Out      string `json:"out,omitempty"`
	Package  string `json:"package,omitempty"`
}

// Operation is one indexed endpoint.
type Operation struct {
	Method      string   `json:"method"`
	Path        string   `json:"path"`
	OperationID string   `json:"operationId,omitempty"`
	Summary     string   `json:"summary,omitempty"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Deprecated  bool     `json:"deprecated,omitempty"`
	Auth        string   `json:"auth,omitempty"`
}

// Finding is one oasdiff checker result.
type Finding struct {
	ID          string `json:"id"`
	Level       string `json:"level"`
	Text        string `json:"text"`
	Operation   string `json:"operation,omitempty"`
	OperationID string `json:"operationId,omitempty"`
	Path        string `json:"path,omitempty"`
	Section     string `json:"section,omitempty"`
}

// Response is one JSON document written to stdout.
type Response struct {
	OK          bool        `json:"ok"`
	Error       string      `json:"error,omitempty"`
	Engine      string      `json:"engine"`
	SpecVersion string      `json:"specVersion,omitempty"`
	OpenAPI     string      `json:"openapi,omitempty"`
	Title       string      `json:"title,omitempty"`
	Bytes       int         `json:"bytes,omitempty"`
	Out         string      `json:"out,omitempty"`
	Operations  []Operation `json:"operations,omitempty"`
	Findings    []Finding   `json:"findings,omitempty"`
}

// Handle runs one engine command. It does not touch the network.
func Handle(req Request) Response {
	resp := Response{Engine: engineLabel()}
	switch req.Command {
	case "version":
		resp.OK = true
		return resp
	case "normalize":
		err, mutate := normalizeCommand(req)
		return finish(resp, err, mutate)
	case "operations":
		err, mutate := operationsCommand(req)
		return finish(resp, err, mutate)
	case "breaking":
		err, mutate := compareCommand(req, "breaking")
		return finish(resp, err, mutate)
	case "changelog":
		err, mutate := compareCommand(req, "changelog")
		return finish(resp, err, mutate)
	case "codegen":
		err, mutate := codegenCommand(req)
		return finish(resp, err, mutate)
	default:
		resp.Error = fmt.Sprintf("unknown command %q", req.Command)
		return resp
	}
}

func finish(resp Response, err error, mutate func(*Response)) Response {
	if err != nil {
		resp.OK = false
		resp.Error = err.Error()
		return resp
	}
	if mutate != nil {
		mutate(&resp)
	}
	resp.OK = true
	return resp
}

func normalizeCommand(req Request) (error, func(*Response)) {
	if req.Spec == "" || req.Out == "" {
		return fmt.Errorf("normalize requires spec and out"), nil
	}
	spec, canonical, err := loadNormalized(req.Spec)
	if err != nil {
		return err, nil
	}
	if err := os.MkdirAll(filepath.Dir(req.Out), 0o755); err != nil {
		return err, nil
	}
	if err := writeCanonical(req.Out, canonical); err != nil {
		return err, nil
	}
	return nil, func(resp *Response) {
		resp.Out = req.Out
		resp.Bytes = len(canonical)
		resp.OpenAPI = spec.OpenAPI
		if spec.Info != nil {
			resp.Title = spec.Info.Title
			resp.SpecVersion = spec.Info.Version
		}
	}
}

func operationsCommand(req Request) (error, func(*Response)) {
	if req.Spec == "" {
		return fmt.Errorf("operations requires spec"), nil
	}
	spec, _, err := loadNormalized(req.Spec)
	if err != nil {
		return err, nil
	}
	ops := listOperations(spec)
	return nil, func(resp *Response) {
		resp.Operations = ops
		if spec.Info != nil {
			resp.Title = spec.Info.Title
			resp.SpecVersion = spec.Info.Version
		}
		resp.OpenAPI = spec.OpenAPI
	}
}

func compareCommand(req Request, mode string) (error, func(*Response)) {
	if req.Base == "" || req.Revision == "" {
		return fmt.Errorf("%s requires base and revision", mode), nil
	}
	findings, err := compare(req.Base, req.Revision, mode)
	if err != nil {
		return err, nil
	}
	return nil, func(resp *Response) {
		resp.Findings = findings
	}
}

func codegenCommand(req Request) (error, func(*Response)) {
	if req.Spec == "" || req.Out == "" {
		return fmt.Errorf("codegen requires spec and out"), nil
	}
	spec, _, err := loadNormalized(req.Spec)
	if err != nil {
		return err, nil
	}
	if err := os.MkdirAll(filepath.Dir(req.Out), 0o755); err != nil {
		return err, nil
	}
	if err := generateGo(spec, req.Package, req.Out); err != nil {
		return err, nil
	}
	return nil, func(resp *Response) {
		resp.Out = req.Out
	}
}

func engineLabel() string {
	oasdiff := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "github.com/oasdiff/oasdiff" {
				oasdiff = dep.Version
			}
		}
	}
	return fmt.Sprintf("apiweld-engine@%s (oasdiff %s)", version, oasdiff)
}
