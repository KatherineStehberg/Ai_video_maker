using System;
using System.Collections.Generic;
using System.Globalization;
using System.Speech.Synthesis;
public static class AvmTimedSpeech {
 public static string[] Synthesize(string text, string voice, string target, int rate, int volume) {
  var marks = new List<string>();
  using (var synth = new SpeechSynthesizer()) {
   if (!String.IsNullOrEmpty(voice)) synth.SelectVoice(voice);
   synth.Rate = rate; synth.Volume = volume;
   synth.SpeakProgress += (sender, e) => { lock(marks) marks.Add(e.AudioPosition.TotalSeconds.ToString("R", CultureInfo.InvariantCulture)+"|"+e.CharacterPosition+"|"+e.CharacterCount); };
   synth.SetOutputToWaveFile(target, new System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, System.Speech.AudioFormat.AudioBitsPerSample.Sixteen, System.Speech.AudioFormat.AudioChannel.Mono)); synth.Speak(text); synth.SetOutputToNull();
  }
  return marks.ToArray();
 }
}
