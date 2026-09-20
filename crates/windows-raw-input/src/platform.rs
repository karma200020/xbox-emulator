#![allow(clippy::borrow_as_ptr)]

use std::{
    collections::HashMap,
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
        mpsc::{SyncSender, channel},
    },
    thread::{self, JoinHandle},
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_CLASS_ALREADY_EXISTS, GetLastError, HANDLE, HWND, LPARAM, LRESULT,
        STILL_ACTIVE, WPARAM,
    },
    System::{
        RemoteDesktop::{
            NOTIFY_FOR_THIS_SESSION, ProcessIdToSessionId, WTSRegisterSessionNotification,
            WTSUnRegisterSessionNotification,
        },
        StationsAndDesktops::{
            CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
        },
        Threading::{
            GetCurrentProcessId, GetExitCodeProcess, GetProcessTimes, OpenProcess,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW,
        },
    },
    UI::{
        Input::{
            GetRawInputData, GetRawInputDeviceInfoW, GetRawInputDeviceList, HRAWINPUT, RAWINPUT,
            RAWINPUTDEVICE, RAWINPUTDEVICELIST, RAWINPUTHEADER, RAWKEYBOARD, RAWMOUSE,
            RID_DEVICE_INFO, RID_INPUT, RIDEV_DEVNOTIFY, RIDEV_INPUTSINK, RIDI_DEVICEINFO,
            RIDI_DEVICENAME, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE, RegisterRawInputDevices,
        },
        WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GWLP_USERDATA,
            GetForegroundWindow, GetMessageW, GetWindowLongPtrW, GetWindowThreadProcessId,
            HWND_MESSAGE, KillTimer, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND, PostMessageW,
            RegisterClassW, SetTimer, SetWindowLongPtrW, TranslateMessage, WM_CLOSE, WM_DESTROY,
            WM_INPUT, WM_INPUT_DEVICE_CHANGE, WM_POWERBROADCAST, WM_TIMER, WM_WTSSESSION_CHANGE,
            WNDCLASSW, WTS_SESSION_LOCK, WTS_SESSION_LOGOFF, WTS_SESSION_LOGON, WTS_SESSION_UNLOCK,
        },
    },
};

use xib_local_input_core::{
    DeviceInstanceId, EventSequence, Generation, InputEvent, InputRecord, LifecycleEvent,
    PowerEvent, SessionEvent, TargetIdentity,
};

use super::{
    AdapterError, AdapterEvent, EmergencyChord, Startup, send_bounded, translate_keyboard,
    translate_mouse,
};

const MAX_RAW_INPUT_BYTES: u32 = 64 * 1024;
const TIMER_ID: usize = 1;
const TIMER_INTERVAL_MS: u32 = 100;
const DESKTOP_READOBJECTS: u32 = 0x0001;

pub struct StopHandle {
    window: Arc<AtomicIsize>,
}

impl StopHandle {
    pub fn request(&self) {
        let window = self.window.load(Ordering::Acquire);
        if window != 0 {
            // SAFETY: Posting WM_CLOSE does not dereference the HWND. It is an
            // opaque value owned by the worker until the worker clears it.
            unsafe {
                PostMessageW(window as HWND, WM_CLOSE, 0, 0);
            }
        }
    }
}

pub struct Started {
    pub startup: Startup,
    pub stop: StopHandle,
    pub worker: JoinHandle<()>,
}

pub fn spawn(
    target_pid: u32,
    sender: SyncSender<AdapterEvent>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    invalidation: Arc<AtomicU64>,
) -> Result<Started, AdapterError> {
    let target = TargetProcess::open(target_pid)?;
    let startup_identity = target.identity.clone();
    let window = Arc::new(AtomicIsize::new(0));
    let worker_window = Arc::clone(&window);
    let (startup_sender, startup_receiver) = channel();
    let worker = thread::Builder::new()
        .name("xib-raw-input".into())
        .spawn(move || {
            let result = run_window(
                target,
                sender,
                generation,
                active,
                Arc::clone(&invalidation),
                &worker_window,
                &startup_sender,
            );
            if result.is_err() {
                invalidation.store(2, Ordering::Release);
            }
            worker_window.store(0, Ordering::Release);
        })
        .map_err(|error| AdapterError::Startup(format!("failed to start input thread: {error}")))?;

    match startup_receiver.recv() {
        Ok(Ok(devices)) => Ok(Started {
            startup: Startup {
                target: startup_identity,
                devices,
            },
            stop: StopHandle { window },
            worker,
        }),
        Ok(Err(error)) => {
            let _ = worker.join();
            Err(error)
        }
        Err(_) => {
            let _ = worker.join();
            Err(AdapterError::Startup(
                "Raw Input worker exited during startup".into(),
            ))
        }
    }
}

struct TargetProcess {
    handle: isize,
    pid: u32,
    executable: String,
    identity: TargetIdentity,
}

impl TargetProcess {
    fn open(pid: u32) -> Result<Self, AdapterError> {
        // SAFETY: No pointers are passed. The returned owned handle is closed
        // by Drop.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(last_error("OpenProcess"));
        }
        let executable = query_process_path(handle).inspect_err(|_| unsafe {
            CloseHandle(handle);
        })?;
        let mut session = 0;
        // SAFETY: session points to initialized writable storage.
        if unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 {
            // SAFETY: handle is owned and valid.
            unsafe {
                CloseHandle(handle);
            }
            return Err(last_error("ProcessIdToSessionId"));
        }
        let mut current_session = 0;
        // SAFETY: current_session points to initialized writable storage.
        if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session) } == 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(last_error("ProcessIdToSessionId"));
        }
        if session != current_session {
            unsafe {
                CloseHandle(handle);
            }
            return Err(AdapterError::InvalidTarget(
                "target process is in a different Windows session".into(),
            ));
        }
        let mut creation = unsafe { zeroed() };
        let mut exit = unsafe { zeroed() };
        let mut kernel = unsafe { zeroed() };
        let mut user = unsafe { zeroed() };
        // SAFETY: all FILETIME outputs point to initialized writable storage.
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            unsafe {
                CloseHandle(handle);
            }
            return Err(last_error("GetProcessTimes"));
        }
        let instance =
            (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        let identity =
            TargetIdentity::new(executable.clone(), u128::from(instance), u64::from(session));
        Ok(Self {
            handle: handle as isize,
            pid,
            executable,
            identity,
        })
    }

    fn is_alive(&self) -> bool {
        let mut code = 0;
        // SAFETY: code is writable and the process handle remains owned.
        unsafe {
            GetExitCodeProcess(self.handle as HANDLE, &mut code) != 0 && code == STILL_ACTIVE as u32
        }
    }

    fn is_foreground(&self) -> bool {
        if !self.owns_foreground_window() {
            return false;
        }
        // Checking the image as well as PID closes stale-window races.
        query_process_path(self.handle as HANDLE).is_ok_and(|path| path == self.executable)
    }

    fn owns_foreground_window(&self) -> bool {
        // SAFETY: The queried HWND is opaque and only used for a PID query.
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.is_null() {
            return false;
        }
        let mut pid = 0;
        // SAFETY: pid is writable; no handle ownership is transferred.
        unsafe {
            GetWindowThreadProcessId(foreground, &mut pid);
        }
        pid == self.pid
    }
}

impl Drop for TargetProcess {
    fn drop(&mut self) {
        // SAFETY: handle was returned by OpenProcess and is closed once.
        unsafe {
            CloseHandle(self.handle as HANDLE);
        }
    }
}

fn query_process_path(handle: HANDLE) -> Result<String, AdapterError> {
    let mut buffer = vec![0_u16; 32_768];
    let mut length = u32::try_from(buffer.len()).expect("path capacity fits u32");
    // SAFETY: buffer is writable for `length` UTF-16 elements.
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return Err(last_error("QueryFullProcessImageNameW"));
    }
    buffer.truncate(length as usize);
    Ok(String::from_utf16_lossy(&buffer).to_lowercase())
}

struct WindowState {
    sender: SyncSender<AdapterEvent>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    invalidation: Arc<AtomicU64>,
    target: TargetProcess,
    devices: HashMap<isize, DeviceInstanceId>,
    chord: EmergencyChord,
    seen_generation: u64,
    seen_active: bool,
    input_sequence: u64,
    lifecycle_sequence: u64,
    priority_sequence: u64,
    foreground: Option<bool>,
    desktop_available: Option<bool>,
}

impl WindowState {
    fn sync_generation(&mut self) -> Generation {
        let generation = self.generation.load(Ordering::Acquire);
        let active = self.active.load(Ordering::Acquire);
        if generation != self.seen_generation {
            self.seen_generation = generation;
            self.input_sequence = 1;
            self.lifecycle_sequence = 1;
            self.priority_sequence = 1;
            self.foreground = None;
            self.desktop_available = None;
            self.chord.reset();
        }
        self.seen_active = active;
        Generation::new(generation)
    }

    fn input(&mut self, device: DeviceInstanceId, event: InputEvent) {
        let generation = self.sync_generation();
        if generation.value() == 0 || !self.seen_active {
            return;
        }
        if !self.target.owns_foreground_window() {
            if self.foreground != Some(false) {
                self.foreground = Some(false);
                self.lifecycle(LifecycleEvent::ForegroundChanged(None));
            }
            return;
        }
        if self.desktop_available != Some(true) {
            return;
        }
        let sequence = EventSequence::new(self.input_sequence);
        self.input_sequence = self.input_sequence.saturating_add(1);
        send_bounded(
            &self.sender,
            &self.invalidation,
            AdapterEvent::Input(InputRecord {
                generation,
                sequence,
                device,
                event,
            }),
        );
    }

    fn lifecycle(&mut self, event: LifecycleEvent) {
        let generation = self.sync_generation();
        if generation.value() == 0 {
            return;
        }
        let sequence = EventSequence::new(self.lifecycle_sequence);
        self.lifecycle_sequence = self.lifecycle_sequence.saturating_add(1);
        send_bounded(
            &self.sender,
            &self.invalidation,
            AdapterEvent::Lifecycle {
                generation,
                sequence,
                event,
            },
        );
    }

    fn emergency(&mut self) {
        let generation = self.sync_generation();
        if generation.value() == 0 || !self.seen_active {
            return;
        }
        let sequence = EventSequence::new(self.priority_sequence);
        self.priority_sequence = self.priority_sequence.saturating_add(1);
        send_bounded(
            &self.sender,
            &self.invalidation,
            AdapterEvent::Emergency {
                generation,
                sequence,
            },
        );
    }
}

#[allow(clippy::too_many_lines)]
fn run_window(
    target: TargetProcess,
    sender: SyncSender<AdapterEvent>,
    generation: Arc<AtomicU64>,
    active: Arc<AtomicBool>,
    invalidation: Arc<AtomicU64>,
    published_window: &AtomicIsize,
    startup_sender: &std::sync::mpsc::Sender<Result<Vec<DeviceInstanceId>, AdapterError>>,
) -> Result<(), AdapterError> {
    let class_name: Vec<u16> = "XibRawInputWindow\0".encode_utf16().collect();
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        lpszClassName: class_name.as_ptr(),
        ..unsafe { zeroed() }
    };
    // SAFETY: class points to a valid static-for-call UTF-16 name and callback.
    if unsafe { RegisterClassW(&class) } == 0 {
        let code = unsafe { GetLastError() };
        if code != ERROR_CLASS_ALREADY_EXISTS {
            let _ = startup_sender.send(Err(AdapterError::Win32("RegisterClassW", code)));
            return Err(AdapterError::Win32("RegisterClassW", code));
        }
    }
    // SAFETY: All string pointers are valid for the call. HWND_MESSAGE creates
    // a non-visible, message-only window with no screen or input suppression.
    let window = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            class_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            null_mut(),
            null_mut(),
            null(),
        )
    };
    if window.is_null() {
        let error = last_error("CreateWindowExW");
        let _ = startup_sender.send(Err(clone_error(&error)));
        return Err(error);
    }

    let devices = enumerate_devices()?;
    let startup_devices = devices.values().copied().collect::<Vec<_>>();
    let state = Box::new(WindowState {
        sender,
        generation,
        active,
        invalidation,
        target,
        devices,
        chord: EmergencyChord::default(),
        seen_generation: 0,
        seen_active: false,
        input_sequence: 1,
        lifecycle_sequence: 1,
        priority_sequence: 1,
        foreground: None,
        desktop_available: None,
    });
    let state = Box::into_raw(state);
    // SAFETY: The pointer remains allocated through the message loop and is
    // reclaimed below after the window stops dispatching messages.
    unsafe {
        SetWindowLongPtrW(window, GWLP_USERDATA, state.cast::<c_void>() as isize);
    }
    if let Err(error) = register_devices(window) {
        unsafe {
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            drop(Box::from_raw(state));
            DestroyWindow(window);
        }
        let _ = startup_sender.send(Err(clone_error(&error)));
        return Err(error);
    }
    // Session registration can fail in restricted environments; periodic
    // desktop/focus/process checks still fail closed.
    let session_registered =
        unsafe { WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) } != 0;
    unsafe {
        SetTimer(window, TIMER_ID, TIMER_INTERVAL_MS, None);
    }
    published_window.store(window as isize, Ordering::Release);
    if startup_sender.send(Ok(startup_devices)).is_err() {
        unsafe {
            DestroyWindow(window);
        }
    } else {
        let mut message: MSG = unsafe { zeroed() };
        loop {
            // SAFETY: message is writable for the duration of the call.
            let result = unsafe { GetMessageW(&mut message, null_mut(), 0, 0) };
            if result <= 0 {
                if result < 0 {
                    unsafe { &*state }.invalidation.store(2, Ordering::Release);
                }
                break;
            }
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }
    published_window.store(0, Ordering::Release);
    unsafe {
        KillTimer(window, TIMER_ID);
        if session_registered {
            WTSUnRegisterSessionNotification(window);
        }
        SetWindowLongPtrW(window, GWLP_USERDATA, 0);
        drop(Box::from_raw(state));
    }
    Ok(())
}

fn register_devices(window: HWND) -> Result<(), AdapterError> {
    let devices = [
        RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x06,
            dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
            hwndTarget: window,
        },
        RAWINPUTDEVICE {
            usUsagePage: 0x01,
            usUsage: 0x02,
            dwFlags: RIDEV_INPUTSINK | RIDEV_DEVNOTIFY,
            hwndTarget: window,
        },
    ];
    // SAFETY: devices is a correctly sized fixed array valid for the call.
    if unsafe {
        RegisterRawInputDevices(
            devices.as_ptr(),
            u32::try_from(devices.len()).expect("two devices fit u32"),
            u32::try_from(size_of::<RAWINPUTDEVICE>()).expect("structure size fits u32"),
        )
    } == 0
    {
        Err(last_error("RegisterRawInputDevices"))
    } else {
        Ok(())
    }
}

fn enumerate_devices() -> Result<HashMap<isize, DeviceInstanceId>, AdapterError> {
    let mut count = 0;
    let list_size =
        u32::try_from(size_of::<RAWINPUTDEVICELIST>()).expect("structure size fits u32");
    // SAFETY: Null first call requests only the count.
    if unsafe { GetRawInputDeviceList(null_mut(), &mut count, list_size) } == u32::MAX {
        return Err(last_error("GetRawInputDeviceList"));
    }
    let mut list = vec![unsafe { zeroed::<RAWINPUTDEVICELIST>() }; count as usize];
    if count != 0 {
        // SAFETY: list contains `count` writable entries.
        let read = unsafe { GetRawInputDeviceList(list.as_mut_ptr(), &mut count, list_size) };
        if read == u32::MAX {
            return Err(last_error("GetRawInputDeviceList"));
        }
        list.truncate(read as usize);
    }
    let mut devices = HashMap::new();
    for item in list {
        if matches!(item.dwType, RIM_TYPEKEYBOARD | RIM_TYPEMOUSE)
            && let Some(id) = device_id(item.hDevice)
        {
            devices.insert(item.hDevice as isize, id);
        }
    }
    if devices.is_empty() {
        return Err(AdapterError::Startup(
            "no Raw Input keyboard or mouse devices are available".into(),
        ));
    }
    Ok(devices)
}

fn device_id(device: HANDLE) -> Option<DeviceInstanceId> {
    let mut info: RID_DEVICE_INFO = unsafe { zeroed() };
    info.cbSize = u32::try_from(size_of::<RID_DEVICE_INFO>()).ok()?;
    let mut info_size = info.cbSize;
    // SAFETY: info is writable and cbSize identifies its version.
    if unsafe {
        GetRawInputDeviceInfoW(
            device,
            RIDI_DEVICEINFO,
            (&raw mut info).cast(),
            &mut info_size,
        )
    } == u32::MAX
    {
        return None;
    }
    if !matches!(info.dwType, RIM_TYPEKEYBOARD | RIM_TYPEMOUSE) {
        return None;
    }
    let mut chars = 0;
    // SAFETY: Null first call requests the UTF-16 character count.
    if unsafe { GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, null_mut(), &mut chars) }
        == u32::MAX
        || chars == 0
        || chars > 32_768
    {
        return None;
    }
    let mut name = vec![0_u16; chars as usize];
    // SAFETY: name is writable for the reported character count.
    if unsafe {
        GetRawInputDeviceInfoW(
            device,
            RIDI_DEVICENAME,
            name.as_mut_ptr().cast(),
            &mut chars,
        )
    } == u32::MAX
    {
        return None;
    }
    name.truncate(chars as usize);
    Some(DeviceInstanceId::new(fnv1a_utf16(&name)))
}

fn fnv1a_utf16(value: &[u16]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for unit in value {
        for byte in unit.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    hash
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: We only store our Box pointer under GWLP_USERDATA and clear it
    // before reclaiming the allocation.
    let state_ptr = unsafe { GetWindowLongPtrW(window, GWLP_USERDATA) } as *mut WindowState;
    if state_ptr.is_null() {
        return unsafe { DefWindowProcW(window, message, wparam, lparam) };
    }
    let state = unsafe { &mut *state_ptr };
    match message {
        WM_INPUT => handle_raw_input(state, lparam as HRAWINPUT),
        WM_INPUT_DEVICE_CHANGE => handle_device_change(state, wparam, lparam),
        WM_TIMER if wparam == TIMER_ID => poll_lifecycle(state),
        WM_WTSSESSION_CHANGE => {
            let event = match u32::try_from(wparam).ok() {
                Some(WTS_SESSION_LOCK) => Some(SessionEvent::Locked),
                Some(WTS_SESSION_UNLOCK) => Some(SessionEvent::Unlocked),
                Some(WTS_SESSION_LOGON) => Some(SessionEvent::Logon),
                Some(WTS_SESSION_LOGOFF) => Some(SessionEvent::Logoff),
                _ => None,
            };
            if let Some(event) = event {
                state.lifecycle(LifecycleEvent::Session(event));
            }
        }
        WM_POWERBROADCAST => match u32::try_from(wparam).ok() {
            Some(PBT_APMSUSPEND) => state.lifecycle(LifecycleEvent::Power(PowerEvent::Suspend)),
            Some(PBT_APMRESUMEAUTOMATIC) => {
                state.lifecycle(LifecycleEvent::Power(PowerEvent::Resume));
            }
            _ => {}
        },
        WM_CLOSE => {
            state.lifecycle(LifecycleEvent::Stop);
            unsafe {
                DestroyWindow(window);
            }
            return 0;
        }
        WM_DESTROY => {
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::PostQuitMessage(0);
            }
            return 0;
        }
        _ => {}
    }
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
}

fn handle_raw_input(state: &mut WindowState, input: HRAWINPUT) {
    let mut bytes = 0;
    let header_size = u32::try_from(size_of::<RAWINPUTHEADER>()).expect("header size fits u32");
    // SAFETY: Null first call requests byte count only.
    if unsafe { GetRawInputData(input, RID_INPUT, null_mut(), &mut bytes, header_size) } == u32::MAX
        || !valid_raw_input_size(bytes)
    {
        state.invalidation.store(2, Ordering::Release);
        return;
    }
    // Keyboard packets are smaller than RAWINPUT's largest union member.
    let words = (bytes as usize)
        .max(size_of::<RAWINPUT>())
        .div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; words];
    let mut copied = bytes;
    // SAFETY: usize storage provides RAWINPUT alignment and at least `bytes`
    // writable bytes. The API-reported copy length is checked exactly.
    if unsafe {
        GetRawInputData(
            input,
            RID_INPUT,
            storage.as_mut_ptr().cast(),
            &mut copied,
            header_size,
        )
    } != bytes
    {
        state.invalidation.store(2, Ordering::Release);
        return;
    }
    // SAFETY: The buffer is aligned and initialized for a full RAWINPUT, including
    // any union padding not supplied by GetRawInputData. The packet's actual
    // payload length is validated before accessing the selected union member.
    let raw = unsafe { &*storage.as_ptr().cast::<RAWINPUT>() };
    if !valid_raw_input_header(&raw.header, bytes) {
        state.invalidation.store(2, Ordering::Release);
        return;
    }
    let Some(device) = device_for_handle(state, raw.header.hDevice) else {
        return;
    };
    match raw.header.dwType {
        RIM_TYPEKEYBOARD => {
            let keyboard = unsafe { raw.data.keyboard };
            let transition = translate_keyboard(keyboard.MakeCode, keyboard.Flags, keyboard.VKey);
            // Emergency detection deliberately precedes publication to mapping.
            if state.chord.observe(transition) {
                state.emergency();
                return;
            }
            state.input(device, transition.event);
        }
        RIM_TYPEMOUSE => {
            let mouse = unsafe { raw.data.mouse };
            let buttons = unsafe { mouse.Anonymous.Anonymous };
            for event in translate_mouse(
                buttons.usButtonFlags,
                buttons.usButtonData,
                mouse.lLastX,
                mouse.lLastY,
            ) {
                state.input(device, event);
            }
        }
        _ => {}
    }
}

fn valid_raw_input_size(bytes: u32) -> bool {
    bytes as usize >= size_of::<RAWINPUTHEADER>() && bytes <= MAX_RAW_INPUT_BYTES
}

fn valid_raw_input_header(header: &RAWINPUTHEADER, bytes: u32) -> bool {
    let payload_size = match header.dwType {
        RIM_TYPEKEYBOARD => size_of::<RAWKEYBOARD>(),
        RIM_TYPEMOUSE => size_of::<RAWMOUSE>(),
        _ => 0,
    };
    header.dwSize <= bytes && header.dwSize as usize >= size_of::<RAWINPUTHEADER>() + payload_size
}

fn device_for_handle(state: &mut WindowState, handle: HANDLE) -> Option<DeviceInstanceId> {
    let key = handle as isize;
    if let Some(device) = state.devices.get(&key) {
        return Some(*device);
    }
    let device = device_id(handle)?;
    state.devices.insert(key, device);
    state.lifecycle(LifecycleEvent::DeviceArrived(device));
    Some(device)
}

fn handle_device_change(state: &mut WindowState, change: WPARAM, device: LPARAM) {
    const GIDC_ARRIVAL: usize = 1;
    const GIDC_REMOVAL: usize = 2;
    let key = device;
    match change {
        GIDC_ARRIVAL => {
            if let Some(id) = device_id(device as HANDLE) {
                state.devices.insert(key, id);
                state.lifecycle(LifecycleEvent::DeviceArrived(id));
            }
        }
        GIDC_REMOVAL => {
            if let Some(id) = state.devices.remove(&key) {
                state.lifecycle(LifecycleEvent::DeviceRemoved(id));
            }
        }
        _ => {}
    }
}

fn poll_lifecycle(state: &mut WindowState) {
    let _ = state.sync_generation();
    if !state.target.is_alive() {
        state.lifecycle(LifecycleEvent::TargetExited);
        return;
    }
    let foreground = state.target.is_foreground();
    if state.foreground != Some(foreground) {
        state.foreground = Some(foreground);
        state.lifecycle(LifecycleEvent::ForegroundChanged(
            foreground.then(|| state.target.identity.clone()),
        ));
    }
    let desktop = default_desktop_available();
    if state.desktop_available != Some(desktop) {
        state.desktop_available = Some(desktop);
        state.lifecycle(LifecycleEvent::DefaultDesktopAvailable(desktop));
    }
}

fn default_desktop_available() -> bool {
    // SAFETY: OpenInputDesktop returns an owned HDESK or null.
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_READOBJECTS) };
    if desktop.is_null() {
        return false;
    }
    let mut required = 0;
    unsafe {
        GetUserObjectInformationW(desktop, UOI_NAME, null_mut(), 0, &mut required);
    }
    let mut name = vec![0_u16; (required as usize).div_ceil(2)];
    // SAFETY: name is writable for `required` bytes and desktop is valid.
    let ok = required > 0
        && unsafe {
            GetUserObjectInformationW(
                desktop,
                UOI_NAME,
                name.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } != 0;
    unsafe {
        CloseDesktop(desktop);
    }
    if !ok {
        return false;
    }
    let end = name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(name.len());
    String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
}

fn last_error(api: &'static str) -> AdapterError {
    AdapterError::Win32(api, unsafe { GetLastError() })
}

fn clone_error(error: &AdapterError) -> AdapterError {
    match error {
        AdapterError::Unsupported => AdapterError::Unsupported,
        AdapterError::InvalidTarget(message) => AdapterError::InvalidTarget(message.clone()),
        AdapterError::Win32(api, code) => AdapterError::Win32(api, *code),
        AdapterError::Startup(message) => AdapterError::Startup(message.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_packet_does_not_require_mouse_union_padding() {
        let bytes = u32::try_from(size_of::<RAWINPUTHEADER>() + size_of::<RAWKEYBOARD>()).unwrap();
        assert!(valid_raw_input_size(bytes));
        let header = RAWINPUTHEADER {
            dwType: RIM_TYPEKEYBOARD,
            dwSize: bytes,
            hDevice: null_mut(),
            wParam: 0,
        };
        assert!(valid_raw_input_header(&header, bytes));
    }

    #[test]
    fn raw_input_rejects_truncated_headers_and_payloads() {
        assert!(!valid_raw_input_size(0));
        assert!(!valid_raw_input_size(
            u32::try_from(size_of::<RAWINPUTHEADER>() - 1).unwrap()
        ));
        assert!(!valid_raw_input_size(MAX_RAW_INPUT_BYTES + 1));
        for (kind, payload_size) in [
            (RIM_TYPEKEYBOARD, size_of::<RAWKEYBOARD>()),
            (RIM_TYPEMOUSE, size_of::<RAWMOUSE>()),
        ] {
            let bytes = u32::try_from(size_of::<RAWINPUTHEADER>() + payload_size).unwrap();
            let mut header = RAWINPUTHEADER {
                dwType: kind,
                dwSize: bytes,
                hDevice: null_mut(),
                wParam: 0,
            };
            assert!(valid_raw_input_header(&header, bytes));
            assert!(!valid_raw_input_header(&header, bytes - 1));
            header.dwSize = bytes - 1;
            assert!(!valid_raw_input_header(&header, bytes));
        }
    }
}
