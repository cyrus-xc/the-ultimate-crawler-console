//go:build !windows

package main

// Rod's leakless launcher owns child cleanup on non-Windows hosts.
func protectSessionChildren() error { return nil }
