package engine

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// canonicalize rewrites JSON with sorted object keys and stable encoding.
func canonicalize(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(sortValue(value)); err != nil {
		return nil, err
	}
	// Encoder.Encode appends a newline; compact form has none.
	compact := bytes.TrimRight(buf.Bytes(), "\n")
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, compact, "", "  "); err != nil {
		return nil, err
	}
	pretty.WriteByte('\n')
	return pretty.Bytes(), nil
}

func sortValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(typed))
		for _, key := range keys {
			out[key] = sortValue(typed[key])
		}
		return sortedObject{keys: keys, values: out}
	case []any:
		for i := range typed {
			typed[i] = sortValue(typed[i])
		}
		return typed
	default:
		return value
	}
}

// sortedObject marshals keys in the given order. encoding/json map order is
// alphabetical already; this type exists so the order stays obvious and so
// json.Number values survive.
type sortedObject struct {
	keys   []string
	values map[string]any
}

func (s sortedObject) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range s.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		keyBytes, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		buf.Write(keyBytes)
		buf.WriteByte(':')
		valBytes, err := marshalValue(s.values[key])
		if err != nil {
			return nil, err
		}
		buf.Write(valBytes)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func marshalValue(value any) ([]byte, error) {
	if object, ok := value.(sortedObject); ok {
		return object.MarshalJSON()
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
