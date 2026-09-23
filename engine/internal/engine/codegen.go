package engine

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/oapi-codegen/oapi-codegen/v2/pkg/codegen"
)

var packageNamePattern = regexp.MustCompile(`[^a-zA-Z0-9]+`)

func generateGo(spec *openapi3.T, packageName, outPath string) error {
	name := sanitizePackage(packageName)
	if name == "" {
		name = "client"
	}
	config := codegen.Configuration{
		PackageName: name,
		Generate: codegen.GenerateOptions{
			Models: true,
			Client: true,
		},
		OutputOptions: codegen.OutputOptions{
			SkipFmt: false,
		},
	}
	if err := config.Validate(); err != nil {
		return err
	}
	source, err := codegen.Generate(spec, config)
	if err != nil {
		return fmt.Errorf("oapi-codegen: %w", err)
	}
	if !strings.Contains(source, "package "+name) {
		return fmt.Errorf("oapi-codegen output missing package %s", name)
	}
	return os.WriteFile(outPath, []byte(source), 0o644)
}

func sanitizePackage(name string) string {
	cleaned := packageNamePattern.ReplaceAllString(strings.ToLower(name), "")
	if cleaned == "" {
		return ""
	}
	if cleaned[0] >= '0' && cleaned[0] <= '9' {
		cleaned = "api" + cleaned
	}
	return cleaned
}
