/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Language, Voice, VoiceCategory, VoiceEngine, SampleVideoPreset } from '../types';
import { VOICE_ENGINE_INFO, VOICE_ENGINES } from '../lib/voiceEngines';

export const LANGUAGES: Language[] = [
  // Prominent Indian Languages
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'hi-IN' },
  { code: 'hinglish', name: 'Hinglish', nativeName: 'हिंग्लिश (Urban Mix)', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'hi-IN', baseCode: 'hi' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'ta-IN' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'te-IN' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'bn-IN' },
  { code: 'mr', name: 'Marathi', nativeName: 'मराठी', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'mr-IN' },
  { code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'gu-IN' },
  { code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'kn-IN' },
  { code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'ml-IN' },
  { code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'pa-IN' },
  { code: 'or', name: 'Odia', nativeName: 'ଓଡ଼ିଆ', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'or-IN' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'ur-IN' },
  { code: 'as', name: 'Assamese', nativeName: 'অসমীয়া', flag: '🇮🇳', category: 'indian', bcp47: 'as-IN', baseCode: 'bn' },

  // The rest of India's scheduled languages
  { code: 'mai', name: 'Maithili', nativeName: 'मैथिली', flag: '🇮🇳', category: 'indian', bcp47: 'mai-IN', baseCode: 'hi' },
  { code: 'ne', name: 'Nepali', nativeName: 'नेपाली', flag: '🇮🇳', category: 'indian', bcp47: 'ne-NP', baseCode: 'hi' },
  { code: 'kok', name: 'Konkani', nativeName: 'कोंकणी', flag: '🇮🇳', category: 'indian', bcp47: 'kok-IN', baseCode: 'mr' },
  { code: 'sd', name: 'Sindhi', nativeName: 'سنڌي', flag: '🇮🇳', category: 'indian', bcp47: 'sd-IN', baseCode: 'ur' },
  { code: 'ks', name: 'Kashmiri', nativeName: 'کٲشُر', flag: '🇮🇳', category: 'indian', bcp47: 'ks-IN', baseCode: 'ur' },
  { code: 'mni', name: 'Manipuri (Meitei)', nativeName: 'মৈতৈলোন্', flag: '🇮🇳', category: 'indian', bcp47: 'mni-IN', baseCode: 'bn' },
  { code: 'sat', name: 'Santali', nativeName: 'ᱥᱟᱱᱛᱟᱲᱤ', flag: '🇮🇳', category: 'indian', bcp47: 'sat-IN' },
  { code: 'sa', name: 'Sanskrit', nativeName: 'संस्कृतम्', flag: '🇮🇳', category: 'indian', bcp47: 'sa-IN', baseCode: 'hi' },
  { code: 'doi', name: 'Dogri', nativeName: 'डोगरी', flag: '🇮🇳', category: 'indian', bcp47: 'doi-IN', baseCode: 'hi' },
  { code: 'brx', name: 'Bodo', nativeName: 'बड़ो', flag: '🇮🇳', category: 'indian', bcp47: 'brx-IN', baseCode: 'hi' },

  // Regional languages and dialects
  { code: 'bho', name: 'Bhojpuri', nativeName: 'भोजपुरी', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'bho-IN', baseCode: 'hi' },
  { code: 'bgc', name: 'Haryanvi', nativeName: 'हरियाणवी', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'bgc-IN', baseCode: 'hi' },
  { code: 'raj', name: 'Rajasthani (Marwari)', nativeName: 'राजस्थानी', flag: '🇮🇳', category: 'indian', bcp47: 'raj-IN', baseCode: 'hi' },
  { code: 'awa', name: 'Awadhi', nativeName: 'अवधी', flag: '🇮🇳', category: 'indian', bcp47: 'awa-IN', baseCode: 'hi' },
  { code: 'mag', name: 'Magahi', nativeName: 'मगही', flag: '🇮🇳', category: 'indian', bcp47: 'mag-IN', baseCode: 'hi' },
  { code: 'hne', name: 'Chhattisgarhi', nativeName: 'छत्तीसगढ़ी', flag: '🇮🇳', category: 'indian', bcp47: 'hne-IN', baseCode: 'hi' },
  { code: 'bns', name: 'Bundeli', nativeName: 'बुंदेली', flag: '🇮🇳', category: 'indian', bcp47: 'bns-IN', baseCode: 'hi' },
  { code: 'gbm', name: 'Garhwali', nativeName: 'गढ़वळि', flag: '🇮🇳', category: 'indian', bcp47: 'gbm-IN', baseCode: 'hi' },
  { code: 'kfy', name: 'Kumaoni', nativeName: 'कुमाऊँनी', flag: '🇮🇳', category: 'indian', bcp47: 'kfy-IN', baseCode: 'hi' },
  { code: 'tcy', name: 'Tulu', nativeName: 'ತುಳು', flag: '🇮🇳', category: 'indian', bcp47: 'tcy-IN', baseCode: 'kn' },
  { code: 'lus', name: 'Mizo', nativeName: 'Mizo ṭawng', flag: '🇮🇳', category: 'indian', bcp47: 'lus-IN', baseCode: 'en' },

  // Global European & Americas
  { code: 'en', name: 'English (US)', nativeName: 'English', flag: '🇺🇸', category: 'global', isPopular: true, bcp47: 'en-US' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸', category: 'global', isPopular: true, bcp47: 'es-ES' },
  { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷', category: 'global', isPopular: true, bcp47: 'fr-FR' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪', category: 'global', isPopular: true, bcp47: 'de-DE' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇧🇷', category: 'global', isPopular: true, bcp47: 'pt-BR' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹', category: 'global', isPopular: false, bcp47: 'it-IT' },

  // Asian & Middle East
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵', category: 'asian', isPopular: true, bcp47: 'ja-JP' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '🇰🇷', category: 'asian', isPopular: true, bcp47: 'ko-KR' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦', category: 'asian', isPopular: false, bcp47: 'ar-SA' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '🇮🇩', category: 'asian', isPopular: false, bcp47: 'id-ID' },

  // Last so a detected "English" still maps to US English (languageMeta matches the first entry).
  { code: 'en_in', name: 'Indian English', nativeName: 'English (India)', flag: '🇮🇳', category: 'indian', isPopular: true, bcp47: 'en-IN', baseCode: 'en' },
];

/** A voice character. Gemini-TTS and Chirp3-HD share Google's voice names, so one persona is offered on every engine. */
interface Persona {
  /** Google's voice name, the identifier both APIs expect. */
  voice: string;
  /** Kept from the original catalog, where every voice was Chirp3-HD, so saved projects keep their voice. */
  chirpId?: string;
  name: string;
  gender: 'male' | 'female';
  languageCode: string;
  languageName: string;
  accent: string;
  category: VoiceCategory;
  description: string;
  avatarUrl?: string;
  sampleQuote: string;
  tags: string[];
  pitch: number;
  speed: number;
}

const PERSONAS: Persona[] = [
  {
    voice: 'Charon', chirpId: 'google-hi-charon', name: 'Aditya', gender: 'male', languageCode: 'hi', languageName: 'Hindi / Indian English', accent: 'Hindi Male', category: 'indian',
    description: 'Professional, articulate corporate voice.',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'नमस्ते! हमारे नए प्रोडक्ट लॉन्च में आपका हार्दिक स्वागत है।', tags: ['Authoritative', 'Hindi'], pitch: 1.0, speed: 1.0,
  },
  {
    voice: 'Aoede', chirpId: 'google-hi-aoede', name: 'Ritu', gender: 'female', languageCode: 'hi', languageName: 'Hindi / Indian English', accent: 'Hindi Female', category: 'indian',
    description: 'Warm, melodious and engaging voice.',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'आज हम आपको एक बहुत ही रोमांचक फीचर दिखाने जा रहे हैं।', tags: ['Warm', 'Hindi'], pitch: 1.05, speed: 1.0,
  },
  {
    voice: 'Puck', chirpId: 'google-hi-puck', name: 'Kabir', gender: 'male', languageCode: 'hi', languageName: 'Hindi / Hinglish', accent: 'Hinglish Male', category: 'conversational',
    description: 'Casual, energetic creator tone tailored for YouTube and social reels.',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'Hey guys! Check out this mindblowing AI update we just dropped.', tags: ['Youthful', 'Energetic'], pitch: 0.98, speed: 1.05,
  },
  {
    voice: 'Despina', chirpId: 'google-hi-despina', name: 'Ishita', gender: 'female', languageCode: 'hi', languageName: 'Hindi / Indian English', accent: 'Hindi Female', category: 'narration',
    description: 'Calm, soothing documentary narration with cinematic presence.',
    avatarUrl: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'इस यात्रा की शुरुआत बहुत सरल थी, लेकिन परिणाम असाधारण रहे।', tags: ['Documentary', 'Calm'], pitch: 0.95, speed: 0.95,
  },
  {
    voice: 'Orus', chirpId: 'google-ta-orus', name: 'Rohan', gender: 'male', languageCode: 'ta', languageName: 'Tamil / South Indian', accent: 'Tamil Male', category: 'professional',
    description: 'Clear, dynamic South Indian voice.',
    avatarUrl: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'வணக்கம்! எங்கள் புதிய AI ஸ்டுடியோவிற்கு வரவேற்கிறோம்.', tags: ['Polished', 'Tamil'], pitch: 1.0, speed: 1.0,
  },
  {
    voice: 'Autonoe', chirpId: 'google-te-autonoe', name: 'Priya', gender: 'female', languageCode: 'te', languageName: 'Telugu / South Indian', accent: 'Telugu Female', category: 'expressive',
    description: 'Expressive and friendly voice with crystal-clear pronunciation.',
    avatarUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'నమస్కారం! ఈ రోజు మనం సరికొత్త టెక్నాలజీని చూద్దాం.', tags: ['Friendly', 'Telugu'], pitch: 1.02, speed: 1.0,
  },
  {
    voice: 'Zephyr', chirpId: 'google-bn-zephyr', name: 'Shreya', gender: 'female', languageCode: 'bn', languageName: 'Bengali', accent: 'Bengali Female', category: 'narration',
    description: 'Soft, lyrical Bengali voice with gentle warmth.',
    avatarUrl: 'https://images.unsplash.com/photo-1554151228-14d9def656e4?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'নমস্কার! আজ আমরা একটি নতুন যাত্রা শুরু করতে চলেছি।', tags: ['Lyrical', 'Bengali'], pitch: 1.02, speed: 0.98,
  },
  {
    voice: 'Algenib', chirpId: 'google-mr-algenib', name: 'Varun', gender: 'male', languageCode: 'mr', languageName: 'Marathi', accent: 'Marathi Male', category: 'professional',
    description: 'Grounded, confident Marathi voice suited for business and civic content.',
    avatarUrl: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'नमस्कार! आज आपण एका महत्त्वाच्या विषयावर चर्चा करणार आहोत.', tags: ['Grounded', 'Marathi'], pitch: 0.97, speed: 1.0,
  },
  {
    voice: 'Leda', chirpId: 'google-gu-leda', name: 'Kavya', gender: 'female', languageCode: 'gu', languageName: 'Gujarati', accent: 'Gujarati Female', category: 'conversational',
    description: 'Bright, friendly Gujarati voice with a natural conversational cadence.',
    avatarUrl: 'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'નમસ્તે! આજે આપણે એક રસપ્રદ વિષય વિશે વાત કરીશું.', tags: ['Conversational', 'Gujarati'], pitch: 1.04, speed: 1.02,
  },
  {
    voice: 'Iapetus', chirpId: 'google-kn-iapetus', name: 'Gokul', gender: 'male', languageCode: 'kn', languageName: 'Kannada', accent: 'Kannada Male', category: 'expressive',
    description: 'Energetic Kannada voice with crisp articulation.',
    avatarUrl: 'https://images.unsplash.com/photo-1463453091185-61582044d556?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'ನಮಸ್ಕಾರ! ಇಂದು ನಾವು ಹೊಸ ವಿಷಯದ ಬಗ್ಗೆ ಮಾತನಾಡೋಣ.', tags: ['Energetic', 'Kannada'], pitch: 0.99, speed: 1.03,
  },
  {
    voice: 'Achernar', chirpId: 'google-ml-achernar', name: 'Suhani', gender: 'female', languageCode: 'ml', languageName: 'Malayalam', accent: 'Malayalam Female', category: 'narration',
    description: 'Calm, articulate Malayalam voice with a documentary-grade cinematic tone.',
    avatarUrl: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'നമസ്കാരം! ഇന്ന് നമ്മൾ ഒരു പുതിയ യാത്ര ആരംഭിക്കുകയാണ്.', tags: ['Documentary', 'Malayalam'], pitch: 1.0, speed: 0.97,
  },
  {
    voice: 'Alnilam', chirpId: 'google-pa-alnilam', name: 'Sunny', gender: 'male', languageCode: 'pa', languageName: 'Punjabi', accent: 'Punjabi Male', category: 'conversational',
    description: 'Warm, hearty Punjabi voice full of energy.',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਅੱਜ ਅਸੀਂ ਇੱਕ ਦਿਲਚਸਪ ਵਿਸ਼ੇ ਬਾਰੇ ਗੱਲ ਕਰਾਂਗੇ।', tags: ['Hearty', 'Punjabi'], pitch: 0.96, speed: 1.04,
  },
  {
    voice: 'Fenrir', chirpId: 'google-en-fenrir', name: 'Arjun', gender: 'male', languageCode: 'en', languageName: 'English (US)', accent: 'American Male', category: 'professional',
    description: 'Silicon Valley executive presentation tone with confidence.',
    avatarUrl: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'Welcome to Dubly. One single video, localized for every audience worldwide.', tags: ['Corporate', 'US English'], pitch: 0.98, speed: 1.0,
  },
  {
    voice: 'Kore', chirpId: 'google-en-kore', name: 'Ananya', gender: 'female', languageCode: 'en', languageName: 'English (US)', accent: 'American Female', category: 'conversational',
    description: 'Friendly, bright modern creator voice perfect for SaaS walkthroughs.',
    avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80',
    sampleQuote: 'Let me show you how fast you can localize an entire video campaign.', tags: ['Friendly', 'US English'], pitch: 1.04, speed: 1.02,
  },
  {
    voice: 'Callirrhoe', name: 'Sanjana', gender: 'female', languageCode: 'or', languageName: 'Odia', accent: 'Odia Female', category: 'conversational',
    description: 'Easy-going, friendly Odia voice for everyday explainers.',
    sampleQuote: 'ନମସ୍କାର! ଆଜି ଆମେ କିଛି ନୂଆ ଶିଖିବା।', tags: ['Easy-going', 'Odia'], pitch: 1.03, speed: 1.0,
  },
  {
    voice: 'Enceladus', name: 'Vikram', gender: 'male', languageCode: 'hi', languageName: 'Hindi', accent: 'Hindi Male', category: 'narration',
    description: 'Breathy, intimate storyteller voice for drama and audiobooks.',
    sampleQuote: 'चलिए, आज की कहानी शुरू करते हैं।', tags: ['Storyteller', 'Hindi'], pitch: 0.96, speed: 0.96,
  },
  {
    voice: 'Umbriel', name: 'Manoj', gender: 'male', languageCode: 'bho', languageName: 'Bhojpuri', accent: 'Bhojpuri Male', category: 'indian',
    description: 'Easy-going Bhojpuri voice with an earthy, familiar warmth.',
    sampleQuote: 'प्रणाम! आज हम रउआ सभे के एगो नया चीज़ देखावे जा रहल बानी।', tags: ['Earthy', 'Bhojpuri'], pitch: 0.98, speed: 1.0,
  },
  {
    voice: 'Algieba', name: 'Imran', gender: 'male', languageCode: 'ur', languageName: 'Urdu', accent: 'Urdu Male', category: 'narration',
    description: 'Smooth, poised Urdu voice with refined diction.',
    sampleQuote: 'آداب! آج ہم آپ کو کچھ نیا دکھانے والے ہیں۔', tags: ['Smooth', 'Urdu'], pitch: 0.97, speed: 0.98,
  },
  {
    voice: 'Erinome', name: 'Nandini', gender: 'female', languageCode: 'as', languageName: 'Assamese', accent: 'Assamese Female', category: 'professional',
    description: 'Clear, precise Assamese voice for learning and news.',
    sampleQuote: 'নমস্কাৰ! আজি আমি এটা নতুন কথা শিকিম।', tags: ['Clear', 'Assamese'], pitch: 1.02, speed: 1.0,
  },
  {
    voice: 'Rasalgethi', name: 'Siddharth', gender: 'male', languageCode: 'mr', languageName: 'Marathi', accent: 'Marathi Male', category: 'professional',
    description: 'Informative Marathi voice for explainers and tutorials.',
    sampleQuote: 'चला, आजच्या गोष्टीला सुरुवात करूया.', tags: ['Informative', 'Marathi'], pitch: 1.0, speed: 1.0,
  },
  {
    voice: 'Laomedeia', name: 'Pooja', gender: 'female', languageCode: 'bgc', languageName: 'Haryanvi', accent: 'Haryanvi Female', category: 'expressive',
    description: 'Upbeat Haryanvi voice full of desi swag.',
    sampleQuote: 'राम राम जी! आज आपां एक नई बात करांगे।', tags: ['Upbeat', 'Haryanvi'], pitch: 1.04, speed: 1.04,
  },
  {
    voice: 'Schedar', name: 'Prakash', gender: 'male', languageCode: 'kn', languageName: 'Kannada', accent: 'Kannada Male', category: 'professional',
    description: 'Even, dependable Kannada voice for corporate content.',
    sampleQuote: 'ಬನ್ನಿ, ಇಂದಿನ ಕಥೆಯನ್ನು ಶುರು ಮಾಡೋಣ.', tags: ['Even', 'Kannada'], pitch: 0.98, speed: 1.0,
  },
  {
    voice: 'Gacrux', name: 'Sunita', gender: 'female', languageCode: 'mai', languageName: 'Maithili', accent: 'Maithili Female', category: 'narration',
    description: 'Mature, grounded Maithili voice for stories and devotional content.',
    sampleQuote: 'प्रणाम! आइ हम सभ किछु नव सिखब।', tags: ['Mature', 'Maithili'], pitch: 0.97, speed: 0.97,
  },
  {
    voice: 'Pulcherrima', name: 'Meera', gender: 'female', languageCode: 'en_in', languageName: 'Indian English', accent: 'Indian English Female', category: 'professional',
    description: 'Forward, confident Indian English presenter voice.',
    sampleQuote: "Namaste! Let's get started with today's episode.", tags: ['Presenter', 'Indian English'], pitch: 1.03, speed: 1.02,
  },
  {
    voice: 'Achird', name: 'Karthik', gender: 'male', languageCode: 'te', languageName: 'Telugu', accent: 'Telugu Male', category: 'conversational',
    description: 'Friendly Telugu voice with a relaxed conversational feel.',
    sampleQuote: 'రండి, ఈ రోజు కథ మొదలుపెడదాం.', tags: ['Friendly', 'Telugu'], pitch: 1.0, speed: 1.02,
  },
  {
    voice: 'Zubenelgenubi', name: 'Bhanu', gender: 'male', languageCode: 'raj', languageName: 'Rajasthani (Marwari)', accent: 'Rajasthani Male', category: 'conversational',
    description: 'Casual Rajasthani voice with warm desert-folk charm.',
    sampleQuote: 'खम्मा घणी सा! पधारो म्हारे देस।', tags: ['Casual', 'Rajasthani'], pitch: 0.97, speed: 1.0,
  },
  {
    voice: 'Vindemiatrix', name: 'Anjali', gender: 'female', languageCode: 'ml', languageName: 'Malayalam', accent: 'Malayalam Female', category: 'narration',
    description: 'Gentle, soothing Malayalam voice for wellness and kids’ content.',
    sampleQuote: 'വരൂ, ഇന്നത്തെ കഥ തുടങ്ങാം.', tags: ['Gentle', 'Malayalam'], pitch: 1.03, speed: 0.96,
  },
  {
    voice: 'Sadachbia', name: 'Vijay', gender: 'male', languageCode: 'ta', languageName: 'Tamil', accent: 'Tamil Male', category: 'expressive',
    description: 'Lively, high-energy Tamil voice for promos and reels.',
    sampleQuote: 'வாருங்கள், இன்றைய கதையைத் தொடங்குவோம்.', tags: ['Lively', 'Tamil'], pitch: 1.0, speed: 1.05,
  },
  {
    voice: 'Sadaltager', name: 'Bikash', gender: 'male', languageCode: 'ne', languageName: 'Nepali', accent: 'Nepali Male', category: 'professional',
    description: 'Knowledgeable Nepali voice for documentaries and explainers.',
    sampleQuote: 'नमस्ते! आज हामी केही नयाँ कुरा सिक्नेछौं।', tags: ['Knowledgeable', 'Nepali'], pitch: 0.98, speed: 0.99,
  },
  {
    voice: 'Sulafat', name: 'Rhea', gender: 'female', languageCode: 'kok', languageName: 'Konkani', accent: 'Konkani Female', category: 'conversational',
    description: 'Warm, homely Konkani voice with coastal Goan charm.',
    sampleQuote: 'नमस्कार! तुमकां सगळ्यांक येवकार।', tags: ['Warm', 'Konkani'], pitch: 1.03, speed: 1.0,
  },
];

// A coloured initials badge for personas without a photo; inline, so it works offline and needs no image host.
function initialsAvatar(name: string, index: number): string {
  const hue = (index * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150"><rect width="150" height="150" fill="hsl(${hue},62%,52%)"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-size="64" font-weight="700" fill="#fff">${name.charAt(0)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const ID_PREFIX: Record<Exclude<VoiceEngine, 'chirp'>, string> = { 'gemini-flash-lite': 'gemini-lite', 'gemini-flash': 'gemini-flash' };

function voiceOf(persona: Persona, index: number, engine: VoiceEngine): Voice {
  const slug = persona.voice.toLowerCase();
  return {
    id: engine === 'chirp' ? persona.chirpId ?? `google-${persona.languageCode}-${slug}` : `${ID_PREFIX[engine]}-${slug}`,
    name: `${persona.name} (${VOICE_ENGINE_INFO[engine].label})`,
    gender: persona.gender,
    languageCode: persona.languageCode,
    languageName: persona.languageName,
    accent: persona.accent,
    category: persona.category,
    description: persona.description,
    avatarUrl: persona.avatarUrl ?? initialsAvatar(persona.name, index),
    sampleQuote: persona.sampleQuote,
    tags: persona.tags,
    pitch: persona.pitch,
    speed: persona.speed,
    provider: 'vertex',
    engine,
    providerVoice: { vertex: persona.voice },
  };
}

// Every persona on every engine, cheapest engine first: VOICES[0] is the fallback voice, and it must be one every plan can use.
// Chirp3-HD voices keep their original ids (e.g. "google-hi-charon") because saved projects reference them.
export const VOICES: Voice[] = VOICE_ENGINES.flatMap((engine) => PERSONAS.map((persona, index) => voiceOf(persona, index, engine)));

// Convenience source videos for the "Try a sample" flow — these are just pre-picked
// public source URLs. Selecting one runs the exact same real STT -> translate -> TTS ->
// render pipeline as an uploaded file (the server downloads the URL and processes it
// like any other upload); there is no canned transcript or translation shortcut.
// URLs are verified reachable directly (checked via curl) — the old Google
// "gtv-videos-bucket" demo bucket used by most Dubly/AI-Studio scaffolds is dead
// (403), so these were replaced with sources confirmed to actually serve.
export const SAMPLE_VIDEOS: SampleVideoPreset[] = [
  {
    id: 'sample-nasa-interview',
    title: 'NASA Astronaut Interview — Return to the Pad',
    description: 'Real spoken-word interview footage (captioned) — ideal for testing full speech transcription and dubbing.',
    duration: 113,
    durationFormatted: '01:53',
    resolution: '1920 × 1080 (Full HD)',
    fileSize: '24 MB',
    detectedLanguage: 'English (US)',
    speakerCount: 2,
    videoUrl:
      'https://images-assets.nasa.gov/video/KSC-20190716-MH-NAS01_0001-Return_to_the_Pad_Crew_Quarters_Broll_HQ_Provided-3226478/KSC-20190716-MH-NAS01_0001-Return_to_the_Pad_Crew_Quarters_Broll_HQ_Provided-3226478~small.mp4',
    thumbnailUrl: 'https://images.unsplash.com/photo-1446776653964-20c1d3a81b06?w=600&auto=format&fit=crop&q=80',
  },
  {
    id: 'sample-flower-clip',
    title: 'Quick Pipeline Smoke Test Clip',
    description: 'A short 5-second nature clip with little to no dialogue — good for a fast end-to-end pipeline check, not a dubbing showcase.',
    duration: 5,
    durationFormatted: '00:05',
    resolution: '960 × 540',
    fileSize: '0.6 MB',
    detectedLanguage: 'English (US)',
    speakerCount: 0,
    videoUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    thumbnailUrl: 'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=600&auto=format&fit=crop&q=80',
  },
];
