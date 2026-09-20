#include <windows.h>
#include <appmodel.h>
#include <xinput.h>

#include <chrono>
#include <iostream>
#include <string_view>
#include <thread>

#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Gaming.Input.h>
#include <winrt/Windows.UI.Input.Preview.Injection.h>

using namespace std::chrono_literals;
using namespace winrt;
using namespace Windows::Gaming::Input;
using namespace Windows::UI::Input::Preview::Injection;

namespace
{
bool HasPackageIdentity()
{
    UINT32 length = 0;
    const LONG result = GetCurrentPackageFullName(&length, nullptr);
    return result == ERROR_INSUFFICIENT_BUFFER;
}

void PrintVisibility()
{
    std::wcout << L"WGI gamepads=" << Gamepad::Gamepads().Size() << L"; XInput slots=";
    bool any = false;
    for (DWORD slot = 0; slot != XUSER_MAX_COUNT; ++slot)
    {
        XINPUT_STATE state{};
        if (XInputGetState(slot, &state) == ERROR_SUCCESS)
        {
            std::wcout << (any ? L"," : L"") << slot;
            any = true;
        }
    }
    std::wcout << (any ? L"" : L"none") << std::endl;
}

int Probe()
{
    std::wcout << L"Probe mode. Press Escape to stop." << std::endl;
    while ((GetAsyncKeyState(VK_ESCAPE) & 0x8000) == 0)
    {
        PrintVisibility();
        std::this_thread::sleep_for(1s);
    }
    return 0;
}

int Inject()
{
    if (!HasPackageIdentity())
    {
        std::wcerr << L"Injection must be run from the registered package layout." << std::endl;
        return 2;
    }

    InputInjector injector = InputInjector::TryCreate();
    if (!injector)
    {
        std::wcerr << L"InputInjector::TryCreate returned null. Check package identity and "
                      L"inputInjectionBrokered authorization."
                   << std::endl;
        return 3;
    }

    injector.InitializeGamepadInjection();
    std::wcout << L"Virtual gamepad initialized. A pulses every second; press Escape for "
                  L"graceful removal."
               << std::endl;

    bool pressed = false;
    while ((GetAsyncKeyState(VK_ESCAPE) & 0x8000) == 0)
    {
        GamepadReading reading{};
        reading.Buttons = pressed ? GamepadButtons::A : GamepadButtons::None;
        injector.InjectGamepadInput(InjectedInputGamepadInfo{reading});
        PrintVisibility();
        pressed = !pressed;
        std::this_thread::sleep_for(1s);
    }

    injector.InjectGamepadInput(InjectedInputGamepadInfo{GamepadReading{}});
    injector.UninitializeGamepadInjection();
    std::wcout << L"Virtual gamepad uninitialized." << std::endl;
    return 0;
}
}

int wmain(int argc, wchar_t** argv)
{
    try
    {
        init_apartment(apartment_type::multi_threaded);
        if (argc == 2 && std::wstring_view{argv[1]} == L"inject")
        {
            return Inject();
        }
        if (argc == 2 && std::wstring_view{argv[1]} == L"probe")
        {
            return Probe();
        }
        std::wcerr << L"Usage: MicrosoftGamepadInjectionSpike.exe inject|probe" << std::endl;
        return 1;
    }
    catch (hresult_error const& error)
    {
        std::wcerr << L"HRESULT 0x" << std::hex << static_cast<unsigned>(error.code().value)
                   << L": " << error.message().c_str() << std::endl;
        return 10;
    }
}
