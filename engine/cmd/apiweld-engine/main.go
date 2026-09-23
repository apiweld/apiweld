package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/apiweld/apiweld/engine/internal/engine"
)

func main() {
	var req engine.Request
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&req); err != nil {
		write(engine.Response{OK: false, Error: fmt.Sprintf("read request: %v", err), Engine: "apiweld-engine"})
		os.Exit(1)
	}
	resp := engine.Handle(req)
	write(resp)
	if !resp.OK {
		os.Exit(1)
	}
}

func write(resp engine.Response) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(resp); err != nil {
		fmt.Fprintf(os.Stderr, "write response: %v\n", err)
		os.Exit(1)
	}
}
