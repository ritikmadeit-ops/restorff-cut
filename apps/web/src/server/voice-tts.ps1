# voice-tts.ps1 — RestorffCut's local voice-over engine (voice-music agent, 2026-10-20).
#
# Turns text into a WAV with per-word timings, using only the speech engines Windows ships with (nothing installed,
# no network, no account). Called by apps/web/src/server/voice.ts; also runnable by hand:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File voice-tts.ps1 -List
#   powershell -NoProfile -ExecutionPolicy Bypass -File voice-tts.ps1 -TextFile line.txt -Out take.wav [-Voice "Microsoft Zira Desktop"] [-Engine sapi|onecore] [-Speed 1.0] [-SampleRate 0]
#
# Engines:
#   sapi    = System.Speech (SAPI 5 "Desktop" voices, 22.05 kHz). Words from SpeakProgress (start), word ends from
#             PhonemeReached (start + duration of the word's last phoneme; it includes the pause after a word, so the
#             server refines ends from the audio). Speed m maps to Rate = round(10 * log3(m)) (SAPI: +10 = ~3x).
#   onecore = Windows.Media.SpeechSynthesis (WinRT, the voices Narrator uses, 16 kHz). Words from word-boundary cues
#             (IncludeWordBoundaryMetadata; start only, end = start). Speed = SpeakingRate (0.5..6).
# Output (stdout, one line of JSON): {ok, engine, voice, wav, sample_rate, duration_s, time_scale,
# words:[{word,start,end,char,len}]} or {ok:false, error}. The text file must be UTF-8. Times are seconds into the WAV.
param(
	[string]$TextFile = "",
	[string]$Out = "",
	[string]$Voice = "",
	[ValidateSet("auto", "sapi", "onecore")][string]$Engine = "auto",
	[double]$Speed = 1.0,
	[int]$SampleRate = 0,
	[switch]$List
)
$Speed = [Math]::Max(0.5, [Math]::Min(2.0, $Speed))
$Rate = [int][Math]::Round(10 * [Math]::Log($Speed) / [Math]::Log(3))

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($object) {
	[Console]::Out.WriteLine((ConvertTo-Json -InputObject $object -Compress -Depth 6))
}

Add-Type -AssemblyName System.Speech
Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Speech.Synthesis;
public class RcWord { public string Text; public double Start; public int Char; public int Len; }
public class RcPhone { public double Start; public double Dur; }
public static class RcSapi {
	public static List<RcWord> Words = new List<RcWord>();
	public static List<RcPhone> Phones = new List<RcPhone>();
	public static string Speak(string text, string voice, int rate, string outPath, int sampleRate) {
		Words = new List<RcWord>();
		Phones = new List<RcPhone>();
		using (SpeechSynthesizer s = new SpeechSynthesizer()) {
			if (!String.IsNullOrEmpty(voice)) s.SelectVoice(voice);
			s.Rate = Math.Max(-10, Math.Min(10, rate));
			if (sampleRate > 0) {
				s.SetOutputToWaveFile(outPath, new System.Speech.AudioFormat.SpeechAudioFormatInfo(sampleRate, System.Speech.AudioFormat.AudioBitsPerSample.Sixteen, System.Speech.AudioFormat.AudioChannel.Mono));
			} else {
				s.SetOutputToWaveFile(outPath);
			}
			s.SpeakProgress += delegate(object o, SpeakProgressEventArgs e) {
				RcWord w = new RcWord();
				w.Text = e.Text; w.Start = e.AudioPosition.TotalSeconds; w.Char = e.CharacterPosition; w.Len = e.CharacterCount;
				Words.Add(w);
			};
			s.PhonemeReached += delegate(object o, PhonemeReachedEventArgs e) {
				RcPhone p = new RcPhone();
				p.Start = e.AudioPosition.TotalSeconds; p.Dur = e.Duration.TotalSeconds;
				Phones.Add(p);
			};
			s.Speak(text);
			string name = s.Voice.Name;
			s.SetOutputToNull();
			return name;
		}
	}
	public static List<string> Voices() {
		List<string> names = new List<string>();
		using (SpeechSynthesizer s = new SpeechSynthesizer()) {
			foreach (InstalledVoice v in s.GetInstalledVoices()) {
				if (v.Enabled) names.Add(v.VoiceInfo.Name + "|" + v.VoiceInfo.Culture.Name + "|" + v.VoiceInfo.Gender.ToString());
			}
		}
		return names;
	}
}
"@

$script:OneCoreReady = $false
function Initialize-OneCore {
	if ($script:OneCoreReady) { return }
	Add-Type -AssemblyName System.Runtime.WindowsRuntime
	$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
	$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
	$script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
			$_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
		})[0]
	$script:OneCoreReady = $true
}

function Wait-WinRt($operation, [Type]$resultType) {
	$task = $script:AsTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
	$null = $task.Wait(-1)
	return $task.Result
}

function Get-OneCoreVoices {
	try {
		Initialize-OneCore
		return @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object {
				[ordered]@{ engine = "onecore"; name = $_.DisplayName; language = $_.Language; gender = $_.Gender.ToString().ToLower() }
			})
	} catch {
		return @()
	}
}

function Get-SapiVoices {
	return @([RcSapi]::Voices() | ForEach-Object {
			$parts = $_.Split("|")
			[ordered]@{ engine = "sapi"; name = $parts[0]; language = $parts[1]; gender = $parts[2].ToLower() }
		})
}

function Read-WavRate([string]$path) {
	$fs = [System.IO.File]::OpenRead($path)
	try {
		$br = New-Object System.IO.BinaryReader($fs)
		$null = $br.ReadBytes(12)
		while ($fs.Position -lt $fs.Length - 8) {
			$id = [System.Text.Encoding]::ASCII.GetString($br.ReadBytes(4))
			$size = $br.ReadUInt32()
			if ($id -eq "fmt ") {
				$null = $br.ReadUInt16()
				$channels = $br.ReadUInt16()
				$rate = $br.ReadUInt32()
				$null = $br.ReadUInt32()
				$align = $br.ReadUInt16()
				$bits = $br.ReadUInt16()
				$fs.Position += ($size - 16)
				continue
			}
			if ($id -eq "data") {
				return @{ rate = $rate; channels = $channels; bits = $bits; seconds = ($size / ($rate * $align)) }
			}
			$fs.Position += $size
		}
		return @{ rate = 0; channels = 0; bits = 0; seconds = 0 }
	} finally {
		$fs.Dispose()
	}
}

try {
	if ($List) {
		$voices = @()
		$voices += Get-SapiVoices
		$voices += Get-OneCoreVoices
		Emit ([ordered]@{ ok = $true; voices = $voices })
		exit 0
	}
	if (-not $TextFile -or -not (Test-Path -LiteralPath $TextFile)) { throw "TextFile is required and must exist" }
	if (-not $Out) { throw "Out is required" }
	$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8).Trim()
	if (-not $text) { throw "the text is empty" }

	$engineUsed = $Engine
	if ($engineUsed -eq "auto") {
		$engineUsed = "sapi"
		if ($Voice -and -not ((Get-SapiVoices) | Where-Object { $_.name -eq $Voice })) {
			if ((Get-OneCoreVoices) | Where-Object { $_.name -eq $Voice }) { $engineUsed = "onecore" }
		}
	}

	$words = New-Object System.Collections.ArrayList
	$timeScale = 1.0
	if ($engineUsed -eq "sapi") {
		$name = [RcSapi]::Speak($text, $Voice, $Rate, $Out, $SampleRate)
		# MEASURED 2026-10-20: System.Speech reports AudioPosition as bytes / 32000 (16 kHz 16-bit mono) whatever the
		# file's real format; at 22.05 kHz every time came out 1.378x too late. Rescale to the file's byte rate.
		$fmt = Read-WavRate $Out
		$bytesPerSecond = $fmt.rate * $fmt.channels * ($fmt.bits / 8)
		if ($bytesPerSecond -gt 0) { $timeScale = 32000.0 / $bytesPerSecond }
		$phones = @([RcSapi]::Phones | Sort-Object Start)
		# (not $list: PowerShell names are case-insensitive and -List is a switch parameter)
		$spoken = @([RcSapi]::Words)
		for ($i = 0; $i -lt $spoken.Count; $i++) {
			$w = $spoken[$i]
			$next = if ($i + 1 -lt $spoken.Count) { $spoken[$i + 1].Start } else { [double]::MaxValue }
			$end = $w.Start
			foreach ($p in $phones) {
				if ($p.Start -ge $w.Start -and $p.Start -lt $next) { $end = [Math]::Max($end, $p.Start + $p.Dur) }
			}
			$null = $words.Add([ordered]@{ word = $w.Text; start = [Math]::Round($w.Start * $timeScale, 4); end = [Math]::Round($end * $timeScale, 4); char = $w.Char; len = $w.Len })
		}
	} else {
		Initialize-OneCore
		$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
		if ($Voice) {
			$match = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $Voice } | Select-Object -First 1
			if (-not $match) { throw "no OneCore voice named $Voice" }
			$synth.Voice = $match
		}
		$synth.Options.IncludeWordBoundaryMetadata = $true
		$synth.Options.SpeakingRate = $Speed
		$stream = Wait-WinRt ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
		$name = $synth.Voice.DisplayName
		foreach ($track in $stream.TimedMetadataTracks) {
			foreach ($cue in $track.Cues) {
				$start = $cue.StartTime.TotalSeconds
				$dur = if ($cue.Duration) { $cue.Duration.TotalSeconds } else { 0 }
				$from = [int]$cue.StartPositionInInput
				$to = [int]$cue.EndPositionInInput
				$null = $words.Add([ordered]@{ word = $cue.Text; start = [Math]::Round($start, 4); end = [Math]::Round($start + $dur, 4); char = $from; len = ($to - $from + 1) })
			}
		}
		$size = [uint32]$stream.Size
		$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
		$null = Wait-WinRt ($reader.LoadAsync($size)) ([uint32])
		$bytes = New-Object byte[] $size
		$reader.ReadBytes($bytes)
		[System.IO.File]::WriteAllBytes($Out, $bytes)
		$reader.Dispose()
		$stream.Dispose()
		$synth.Dispose()
	}
	$info = Read-WavRate $Out
	Emit ([ordered]@{
			ok          = $true
			engine      = $engineUsed
			voice       = $name
			wav         = $Out
			sample_rate = $info.rate
			channels    = $info.channels
			bits        = $info.bits
			duration_s  = [Math]::Round($info.seconds, 4)
			time_scale  = [Math]::Round($timeScale, 6)
			words       = @($words)
		})
	exit 0
} catch {
	Emit ([ordered]@{ ok = $false; error = $_.Exception.Message })
	exit 1
}
