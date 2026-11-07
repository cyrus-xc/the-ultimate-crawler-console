//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

// Keep the handle alive until process exit. Windows then terminates the
// service's browser children even after a crash or forced service termination.
var sessionJob windows.Handle

func protectSessionChildren() error {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, windows.CurrentProcess())
	}
	if err != nil {
		windows.CloseHandle(job)
		return err
	}
	sessionJob = job
	return nil
}
