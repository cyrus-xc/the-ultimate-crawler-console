package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func invokeOffline(t *testing.T, command, input string) (int, map[string]any) {
	t.Helper()
	dir := t.TempDir()
	inPath := filepath.Join(dir, "input.json")
	if err := os.WriteFile(inPath, []byte(input), 0600); err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(inPath)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	outPath := filepath.Join(dir, "output.json")
	out, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}
	oldArgs, oldIn, oldOut := os.Args, os.Stdin, os.Stdout
	defer func() { os.Args = oldArgs; os.Stdin = oldIn; os.Stdout = oldOut }()
	os.Args = []string{"crawler", command}
	os.Stdin = in
	os.Stdout = out
	code := run()
	out.Close()
	raw, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err = json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return code, result
}

func TestOfflineHealthAndNetworkGate(t *testing.T) {
	t.Setenv("ENABLE_XHS_BROWSER_NETWORK", "false")
	code, health := invokeOffline(t, "health", "")
	if code != 0 || health["login"] != "not_checked" || health["navigation_version"] != "xhs_note_navigation_v2" {
		t.Fatal(code, health)
	}
	code, result := invokeOffline(t, "read", `{"kind":"profile","id":"5f8c574500000000010085bc"}`)
	if code != 1 || result["error"] != "CRAWLER_NETWORK_DISABLED" {
		t.Fatal(code, result)
	}
	for _, input := range []string{`{"kind":"publish"}`, `{"kind":"profile","unknown":true}`, `{} {}`} {
		if code, _ := invokeOffline(t, "read", input); code != 1 {
			t.Fatal("accepted invalid input", input)
		}
	}
}
