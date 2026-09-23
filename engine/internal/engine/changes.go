package engine

import (
	"fmt"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/oasdiff/oasdiff/checker"
	"github.com/oasdiff/oasdiff/diff"
	"github.com/oasdiff/oasdiff/load"
)

func compare(basePath, revisionPath, mode string) ([]Finding, error) {
	base, err := specInfo(basePath)
	if err != nil {
		return nil, fmt.Errorf("base: %w", err)
	}
	revision, err := specInfo(revisionPath)
	if err != nil {
		return nil, fmt.Errorf("revision: %w", err)
	}
	report, sources, err := diff.GetWithOperationsSourcesMap(diff.NewConfig(), base, revision)
	if err != nil {
		return nil, err
	}
	if report == nil {
		return []Finding{}, nil
	}
	localizer := checker.NewLocalizer("en")
	config := checker.NewConfig(checker.GetAllChecks())
	var changes checker.Changes
	switch mode {
	case "breaking":
		changes = checker.CheckBackwardCompatibility(config, report, sources)
	case "changelog":
		changes = checker.CheckBackwardCompatibilityUntilLevel(config, report, sources, checker.INFO)
	default:
		return nil, fmt.Errorf("unknown compare mode %q", mode)
	}
	findings := make([]Finding, 0, len(changes))
	for _, change := range changes {
		findings = append(findings, Finding{
			ID:          change.GetId(),
			Level:       levelName(change.GetLevel()),
			Text:        change.GetUncolorizedText(localizer),
			Operation:   change.GetOperation(),
			OperationID: change.GetOperationId(),
			Path:        change.GetPath(),
			Section:     change.GetSection(),
		})
	}
	return findings, nil
}

func specInfo(path string) (*load.SpecInfo, error) {
	spec, canonical, err := loadNormalized(path)
	if err != nil {
		return nil, err
	}
	_ = spec
	loader := openapi3.NewLoader()
	loader.IsExternalRefsAllowed = false
	return load.NewSpecInfoFromData(loader, canonical, path)
}

func levelName(level checker.Level) string {
	switch level {
	case checker.ERR:
		return "ERR"
	case checker.WARN:
		return "WARN"
	case checker.INFO:
		return "INFO"
	default:
		return fmt.Sprintf("LEVEL_%d", int(level))
	}
}
