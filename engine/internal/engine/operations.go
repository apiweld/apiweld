package engine

import (
	"sort"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
)

func listOperations(spec *openapi3.T) []Operation {
	if spec == nil || spec.Paths == nil {
		return []Operation{}
	}
	ops := make([]Operation, 0)
	for path, item := range spec.Paths.Map() {
		if item == nil {
			continue
		}
		for method, operation := range item.Operations() {
			if operation == nil {
				continue
			}
			tags := append([]string(nil), operation.Tags...)
			sort.Strings(tags)
			ops = append(ops, Operation{
				Method:      strings.ToUpper(method),
				Path:        path,
				OperationID: operation.OperationID,
				Summary:     operation.Summary,
				Description: operation.Description,
				Tags:        tags,
				Deprecated:  operation.Deprecated,
				Auth:        authSummary(spec, operation),
			})
		}
	}
	sort.Slice(ops, func(i, j int) bool {
		if ops[i].Path == ops[j].Path {
			return ops[i].Method < ops[j].Method
		}
		return ops[i].Path < ops[j].Path
	})
	return ops
}

func authSummary(spec *openapi3.T, operation *openapi3.Operation) string {
	var requirements *openapi3.SecurityRequirements
	if operation.Security != nil {
		requirements = operation.Security
	} else if spec.Security != nil {
		copied := spec.Security
		requirements = &copied
	}
	if requirements == nil || len(*requirements) == 0 {
		return "none"
	}
	labels := make([]string, 0)
	for _, requirement := range *requirements {
		names := make([]string, 0, len(requirement))
		for name := range requirement {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			labels = append(labels, schemeLabel(spec, name))
		}
	}
	if len(labels) == 0 {
		return "none"
	}
	return strings.Join(labels, ", ")
}

func schemeLabel(spec *openapi3.T, name string) string {
	if spec.Components == nil || spec.Components.SecuritySchemes == nil {
		return name
	}
	ref := spec.Components.SecuritySchemes[name]
	if ref == nil || ref.Value == nil {
		return name
	}
	scheme := ref.Value
	switch scheme.Type {
	case "http":
		if scheme.Scheme != "" {
			return scheme.Scheme
		}
		return "http"
	case "apiKey":
		if scheme.In != "" && scheme.Name != "" {
			return "apiKey (" + scheme.In + " " + scheme.Name + ")"
		}
		return "apiKey"
	case "oauth2":
		return "oauth2"
	case "openIdConnect":
		return "openIdConnect"
	default:
		if scheme.Type == "" {
			return name
		}
		return scheme.Type
	}
}
