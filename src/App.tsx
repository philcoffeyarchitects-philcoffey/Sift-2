import React, { useState, useRef, useEffect } from 'react';
import Papa from 'papaparse';
import { motion, useMotionValue, useTransform, PanInfo, AnimatePresence } from 'motion/react';
import { Upload, Download, Check, X, HelpCircle, Building2, User, ChevronRight, RotateCcw, LogOut, LogIn, Star, MapPin, Pause, Undo2, Handshake, PenLine, Briefcase, Map, Mail, Linkedin, Globe, FileText, UserCircle, AlertCircle } from 'lucide-react';
import { cn } from './lib/utils';
import { auth, db, signIn, logOut } from './firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, doc, writeBatch, onSnapshot, query, serverTimestamp, updateDoc, deleteDoc, getDocs, getDocsFromCache, getDocsFromServer } from 'firebase/firestore';

type Decision = 'pending' | 'keep' | 'bin' | 'meet' | 'park' | 'priority';

type Contact = {
  id: string;
  name: string;
  company: string;
  email?: string;
  status: Decision;
  met?: boolean;
  notes?: string;
  sourceFile?: string;
  originalData: string;
  createdAt?: any;
  updatedAt?: any;
};

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [history, setHistory] = useState<string[]>([]); // Stack of contact IDs for undo
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [isUploading, setIsUploading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [hasInitialLoad, setHasInitialLoad] = useState(false);

  // Note Bottom Sheet State
  const [isNoteSheetOpen, setIsNoteSheetOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [currentNote, setCurrentNote] = useState("");
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchContacts = async () => {
    if (!user) return;
    setIsRefreshing(true);
    setFetchError(null);
    try {
      const contactsRef = collection(db, 'users', user.uid, 'contacts');
      const q = query(contactsRef);
      
      let snapshot;
      try {
        // Try server first
        snapshot = await getDocsFromServer(q);
      } catch (serverError: any) {
        console.warn("Server fetch failed, trying cache:", serverError);
        // Fallback to cache if server fails (e.g. quota exceeded)
        try {
          snapshot = await getDocsFromCache(q);
          if (snapshot.empty) {
            // If cache is also empty, re-throw the server error to show the UI
            throw serverError;
          }
        } catch (cacheError) {
          // If cache fetch also fails, throw the original server error
          throw serverError;
        }
      }
      
      const allContacts: Contact[] = [];
      snapshot.forEach((doc) => {
        allContacts.push({ id: doc.id, ...doc.data() } as Contact);
      });

      // Sort by creation time to maintain order
      allContacts.sort((a, b) => {
        const timeA = a.createdAt?.toMillis?.() || 0;
        const timeB = b.createdAt?.toMillis?.() || 0;
        return timeA - timeB;
      });

      setContacts(allContacts);
    } catch (error: any) {
      console.error("Firestore Fetch Error: ", error);
      setFetchError(error?.message || "Failed to load contacts");
    } finally {
      setIsRefreshing(false);
      setHasInitialLoad(true);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!isAuthReady || !user) return;
    fetchContacts();
  }, [user, isAuthReady]);

  const sourceFiles = Array.from(new Set(contacts.map(c => c.sourceFile).filter(Boolean))) as string[];
  
  // Filter contacts
  const filteredPending = contacts.filter(c => 
    c.status === 'pending' && 
    (activeFilter === 'all' || c.sourceFile === activeFilter)
  );
  
  const currentContact = filteredPending[0];

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !user) return;

    setIsUploading(true);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      await new Promise<void>((resolve) => {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {
            if (!results.data || results.data.length === 0) {
              resolve();
              return;
            }

            const keys = Object.keys(results.data[0] as object);
            const nameKey = keys.find(k => /name|first/i.test(k)) || keys[0];
            const companyKey = keys.find(k => /company|org|account/i.test(k)) || (keys.length > 1 ? keys[1] : null);
            const emailKey = keys.find(k => /email|mail/i.test(k));

            try {
              const contactsRef = collection(db, 'users', user.uid, 'contacts');
              const batches = [];
              let currentBatch = writeBatch(db);
              let operationCount = 0;

              // Create a set of existing emails for fast lookup
              const existingEmails = new Set(contacts.map(c => c.email?.toLowerCase()).filter(Boolean));

              for (let j = 0; j < results.data.length; j++) {
                const row: any = results.data[j];
                const email = emailKey && row[emailKey] ? String(row[emailKey]).trim().toLowerCase() : null;

                // Skip if email already exists
                if (email && existingEmails.has(email)) {
                  continue;
                }

                const newDocRef = doc(contactsRef);
                
                const contactData = {
                  name: row[nameKey] ? String(row[nameKey]).trim() : 'Unknown Name',
                  company: companyKey && row[companyKey] ? String(row[companyKey]).trim() : '',
                  email: email || '',
                  status: 'pending',
                  sourceFile: file.name,
                  originalData: JSON.stringify(row),
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp(),
                };

                currentBatch.set(newDocRef, contactData);
                operationCount++;

                if (operationCount === 500) {
                  batches.push(currentBatch.commit());
                  currentBatch = writeBatch(db);
                  operationCount = 0;
                }
              }

              if (operationCount > 0) {
                batches.push(currentBatch.commit());
              }

              await Promise.all(batches);
              await fetchContacts();
            } catch (error: any) {
              console.error("Error uploading contacts:", error);
            } finally {
              resolve();
            }
          },
          error: (error) => {
            console.error(`Error parsing CSV: ${error.message}`);
            resolve();
          }
        });
      });
    }
    
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateContact = async (id: string, updates: Partial<Contact>) => {
    if (!user) return;
    try {
      const contactRef = doc(db, 'users', user.uid, 'contacts', id);
      await updateDoc(contactRef, {
        ...updates,
        updatedAt: serverTimestamp()
      });
    } catch (error: any) {
      console.error("Error updating contact:", error);
    }
  };

  const handleDecision = async (decision: Decision) => {
    if (!currentContact || !user) return;
    
    const contactId = currentContact.id;
    
    // Optimistic update
    setContacts(prev => prev.map(c => c.id === contactId ? { ...c, status: decision } : c));
    setHistory(prev => [...prev, contactId]);

    try {
      const contactRef = doc(db, 'users', user.uid, 'contacts', contactId);
      await updateDoc(contactRef, {
        status: decision,
        updatedAt: serverTimestamp()
      });
    } catch (error: any) {
      console.error("Error updating contact:", error);
      fetchContacts(); // Revert on error
    }
  };

  const handleUndo = async () => {
    if (history.length === 0 || !user) return;
    
    const lastId = history[history.length - 1];
    
    // Optimistic update
    setContacts(prev => prev.map(c => c.id === lastId ? { ...c, status: 'pending' } : c));
    setHistory(prev => prev.slice(0, -1));

    try {
      const contactRef = doc(db, 'users', user.uid, 'contacts', lastId);
      await updateDoc(contactRef, {
        status: 'pending',
        updatedAt: serverTimestamp()
      });
    } catch (error: any) {
      console.error("Error undoing decision:", error);
      fetchContacts(); // Revert on error
    }
  };

  const toggleMet = async () => {
    if (!currentContact || !user) return;
    
    const contactId = currentContact.id;
    const newMet = !currentContact.met;
    
    // Optimistic update
    setContacts(prev => prev.map(c => c.id === contactId ? { ...c, met: newMet } : c));

    try {
      const contactRef = doc(db, 'users', user.uid, 'contacts', contactId);
      await updateDoc(contactRef, {
        met: newMet,
        updatedAt: serverTimestamp()
      });
    } catch (error: any) {
      console.error("Error toggling met:", error);
      fetchContacts(); // Revert on error
    }
  };

  const saveNote = async () => {
    if (!currentContact || !user) return;
    
    const contactId = currentContact.id;
    const note = currentNote;
    
    // Optimistic update
    setContacts(prev => prev.map(c => c.id === contactId ? { ...c, notes: note } : c));
    setIsNoteSheetOpen(false);

    try {
      const contactRef = doc(db, 'users', user.uid, 'contacts', contactId);
      await updateDoc(contactRef, {
        notes: note,
        updatedAt: serverTimestamp()
      });
    } catch (error: any) {
      console.error("Error saving note:", error);
      fetchContacts(); // Revert on error
    }
  };

  const openNoteSheet = () => {
    if (!currentContact) return;
    setCurrentNote(currentContact.notes || "");
    setIsNoteSheetOpen(true);
  };

  const reviewParked = async () => {
    if (!user) return;
    const parkedContacts = contacts.filter(c => c.status === 'park');
    if (parkedContacts.length === 0) return;

    try {
      const batches = [];
      let currentBatch = writeBatch(db);
      let operationCount = 0;

      for (const contact of parkedContacts) {
        const contactRef = doc(db, 'users', user.uid, 'contacts', contact.id);
        currentBatch.update(contactRef, { status: 'pending', updatedAt: serverTimestamp() });
        operationCount++;

        if (operationCount === 500) {
          batches.push(currentBatch.commit());
          currentBatch = writeBatch(db);
          operationCount = 0;
        }
      }

      if (operationCount > 0) {
        batches.push(currentBatch.commit());
      }

      await Promise.all(batches);
      await fetchContacts();
    } catch (error: any) {
      console.error("Error reviewing parked:", error);
    }
  };

  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [exportCsvText, setExportCsvText] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const clearData = async (scope: 'all' | 'current') => {
    if (!user) return;
    try {
      const contactsRef = collection(db, 'users', user.uid, 'contacts');
      let snapshot;
      
      if (scope === 'current' && activeFilter !== 'all') {
        // We fetch all and filter manually to avoid complex indexing for now
        const allDocs = await getDocs(contactsRef);
        const docsToDelete = allDocs.docs.filter(doc => doc.data().sourceFile === activeFilter);
        
        const batches = [];
        let currentBatch = writeBatch(db);
        let operationCount = 0;

        docsToDelete.forEach((doc) => {
          currentBatch.delete(doc.ref);
          operationCount++;

          if (operationCount === 500) {
            batches.push(currentBatch.commit());
            currentBatch = writeBatch(db);
            operationCount = 0;
          }
        });

        if (operationCount > 0) {
          batches.push(currentBatch.commit());
        }
        await Promise.all(batches);
      } else {
        snapshot = await getDocs(contactsRef);
        const batches = [];
        let currentBatch = writeBatch(db);
        let operationCount = 0;

        snapshot.forEach((doc) => {
          currentBatch.delete(doc.ref);
          operationCount++;

          if (operationCount === 500) {
            batches.push(currentBatch.commit());
            currentBatch = writeBatch(db);
            operationCount = 0;
          }
        });

        if (operationCount > 0) {
          batches.push(currentBatch.commit());
        }
        await Promise.all(batches);
      }
      
      await fetchContacts();
      setIsClearConfirmOpen(false);
      setIsHistoryOpen(false);
      setHistory([]);
      if (scope === 'current' && activeFilter !== 'all') {
        setActiveFilter('all');
      }
      alert(scope === 'all' ? "All data cleared successfully." : `Data for "${activeFilter}" cleared successfully.`);
    } catch (error: any) {
      console.error("Error clearing data:", error);
      alert("Failed to clear data. Please try again.");
    }
  };

  const exportCSV = () => {
    const dataToExport = contacts.filter(c => activeFilter === 'all' || c.sourceFile === activeFilter);
    if (dataToExport.length === 0) return;

    try {
      const exportData = dataToExport.map(c => {
        let original = {};
        try {
          original = typeof c.originalData === 'string' ? JSON.parse(c.originalData) : c.originalData;
        } catch (e) {
          original = { 'Raw Data': c.originalData };
        }
        
        return {
          ...original,
          Decision: c.status === 'meet' ? 'MET' : c.status.toUpperCase(),
          Met: c.met ? 'Yes' : '',
          'Triage Notes': c.notes || ''
        };
      });
      
      const csv = Papa.unparse(exportData);
      if (!csv) throw new Error("Generated CSV is empty");
      
      setExportCsvText(csv);
      
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      
      link.style.display = 'none';
      link.href = url;
      const fileName = activeFilter === 'all' ? 'All_Decisions' : activeFilter.replace('.csv', '') + '_Decisions';
      link.download = `TheSift_${fileName}_${new Date().toISOString().split('T')[0]}.csv`;
      link.target = "_blank";
      
      document.body.appendChild(link);
      link.click();
      
      // Cleanup with a slight delay to ensure the browser handles the download
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setIsExportModalOpen(true);
      }, 100);
    } catch (error) {
      console.error("Export failed:", error);
      setIsExportModalOpen(true);
    }
  };

  const downloadCsvAgain = () => {
    console.log("Attempting download again...");
    if (!exportCsvText) {
      console.error("No exportCsvText found");
      alert("No data available to download. Please try exporting again.");
      return;
    }
    try {
      const blob = new Blob([exportCsvText], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.style.display = 'none';
      link.href = url;
      link.download = `TheSift_Export_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, 100);
    } catch (err) {
      console.error("Download again failed:", err);
      alert("Download failed. Please try copying to clipboard instead.");
    }
  };

  const copyExportToClipboard = async () => {
    console.log("Attempting copy to clipboard...");
    if (!exportCsvText) {
      console.error("No exportCsvText found");
      alert("No data available to copy. Please try exporting again.");
      return;
    }

    try {
      // Try modern clipboard API
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(exportCsvText);
        console.log("Copy successful via Clipboard API");
        alert("CSV copied to clipboard!");
        return;
      }
      throw new Error("Clipboard API unavailable or not secure context");
    } catch (err) {
      console.warn("Clipboard API failed, trying fallback:", err);
      // Fallback for non-secure contexts or restricted iframes
      try {
        const textArea = document.createElement("textarea");
        textArea.value = exportCsvText;
        
        // Ensure it's not visible but still in the DOM
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (successful) {
          console.log("Copy successful via fallback");
          alert("CSV copied to clipboard (fallback)!");
        } else {
          throw new Error("execCommand failed");
        }
      } catch (err2) {
        console.error("Copy failed:", err2);
        alert("Failed to copy. Please try selecting the text manually if possible.");
      }
    }
  };

  if (!isAuthReady) {
    return <div className="min-h-[100dvh] bg-gray-50 flex items-center justify-center">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="min-h-[100dvh] bg-gray-50 flex flex-col items-center justify-center p-6">
        <div className="w-24 h-24 bg-indigo-100 rounded-full flex items-center justify-center mb-6">
          <User className="w-12 h-12 text-indigo-600" />
        </div>
        <h1 className="text-4xl font-bold text-gray-900 mb-2 tracking-tight">The Sift</h1>
        <p className="text-gray-500 mb-10 text-center max-w-sm text-lg">
          Triage your contacts at speed. Swipe to decide, pick up where you left off.
        </p>
        <button 
          onClick={signIn}
          className="w-full max-w-sm bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-4 px-8 rounded-2xl shadow-lg transition-colors flex items-center justify-center gap-3 text-lg"
        >
          <LogIn className="w-6 h-6" />
          Sign in with Google
        </button>
      </div>
    );
  }

  const stats = {
    keep: contacts.filter(c => c.status === 'keep').length,
    bin: contacts.filter(c => c.status === 'bin').length,
    meet: contacts.filter(c => c.status === 'meet').length,
    park: contacts.filter(c => c.status === 'park').length,
    priority: contacts.filter(c => c.status === 'priority').length,
    pending: contacts.filter(c => c.status === 'pending').length,
  };

  const totalInFilter = contacts.filter(c => activeFilter === 'all' || c.sourceFile === activeFilter).length;
  const pendingInFilter = filteredPending.length;
  const doneInFilter = totalInFilter - pendingInFilter;
  const progress = totalInFilter > 0 ? Math.round((doneInFilter / totalInFilter) * 100) : 0;

  return (
    <div className="h-[100dvh] bg-gray-50 flex flex-col font-sans text-gray-900 overflow-hidden w-full max-w-md mx-auto relative shadow-2xl">
      
      {/* Top Bar */}
      {contacts.length > 0 && (
        <div className="bg-white shadow-sm z-10 flex flex-col">
          {/* Progress Bar */}
          <div className="w-full bg-gray-100 h-1">
            <div 
              className="bg-indigo-600 h-1 transition-all duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          
          <div className="px-4 py-2 flex items-center justify-between text-xs font-medium text-gray-500 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <select 
                value={activeFilter}
                onChange={(e) => setActiveFilter(e.target.value)}
                className="bg-transparent border-none outline-none text-gray-700 font-semibold max-w-[150px] truncate"
              >
                <option value="all">All Files</option>
                {sourceFiles.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <button 
                onClick={fetchContacts}
                disabled={isRefreshing}
                className={cn("p-1 text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors", isRefreshing && "animate-spin")}
                title="Refresh data"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="p-1 text-indigo-600 hover:bg-indigo-50 rounded-full transition-colors"
                title="Import another CSV"
              >
                <Upload className="w-4 h-4" />
              </button>
            </div>
            
            <div className="tabular-nums">
              {doneInFilter} of {totalInFilter}
            </div>
            
            <div className="flex items-center gap-3">
              <button onClick={() => setIsHistoryOpen(true)} className="text-gray-400 hover:text-gray-600">
                <FileText className="w-4 h-4" />
              </button>
              <button onClick={exportCSV} className="text-indigo-600 font-semibold hover:text-indigo-800">
                Export
              </button>
            </div>
          </div>

          {/* Stats Row */}
          <div className="flex items-center justify-between px-4 py-2 bg-gray-50/50 text-[10px] font-bold uppercase tracking-wider">
            <div className="flex flex-col items-center text-green-600"><span className="text-sm">{stats.keep}</span> Keep</div>
            <div className="flex flex-col items-center text-red-600"><span className="text-sm">{stats.bin}</span> Bin</div>
            <div className="flex flex-col items-center text-blue-600"><span className="text-sm">{stats.meet}</span> Met</div>
            <div className="flex flex-col items-center text-amber-600"><span className="text-sm">{stats.park}</span> Park</div>
            <div className="flex flex-col items-center text-purple-600"><span className="text-sm">{stats.priority}</span> Priority</div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative w-full overflow-hidden">
        
        {!hasInitialLoad && isRefreshing && contacts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mb-6"></div>
            <h2 className="text-xl font-bold mb-2">Checking for existing data...</h2>
            <p className="text-gray-500">Please wait a moment while we sync with Firestore.</p>
          </div>
        ) : fetchError ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mb-6">
              <AlertCircle className="w-10 h-10 text-red-600" />
            </div>
            <h2 className="text-2xl font-bold mb-3 tracking-tight">Failed to Load Data</h2>
            <p className="text-gray-500 mb-8 max-w-xs mx-auto">
              {fetchError.includes('Quota exceeded') 
                ? "The database has reached its free limit. If you've upgraded to Blaze, this might take a moment to propagate."
                : "There was an error fetching your contacts. Please check your connection and try again."}
            </p>
            <button 
              onClick={fetchContacts}
              disabled={isRefreshing}
              className="w-full max-w-xs bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-6 rounded-2xl shadow-lg transition-colors flex items-center justify-center gap-3 text-lg"
            >
              {isRefreshing ? <span className="animate-pulse">Refreshing...</span> : "Try Again"}
            </button>
            <div className="mt-8 flex items-center gap-6">
              <button onClick={logOut} className="text-gray-400 font-medium flex items-center gap-2">
                 <LogOut className="w-4 h-4" /> Sign Out
              </button>
            </div>
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
            <div className="w-24 h-24 bg-indigo-100 rounded-full flex items-center justify-center mb-6">
              <Upload className="w-12 h-12 text-indigo-600" />
            </div>
            <h2 className="text-3xl font-bold mb-3 tracking-tight">Upload CSV</h2>
            <p className="text-gray-500 mb-8 text-lg">
              Upload your contacts to start sifting. You can upload multiple files.
            </p>
            
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-bold py-4 px-6 rounded-2xl shadow-lg transition-colors flex items-center justify-center gap-3 text-lg"
            >
              {isUploading ? (
                <span className="animate-pulse">Uploading...</span>
              ) : (
                <>
                  <Upload className="w-6 h-6" />
                  Select CSV Files
                </>
              )}
            </button>

            <button 
              onClick={fetchContacts}
              disabled={isRefreshing}
              className="w-full mt-4 bg-white border-2 border-indigo-600 text-indigo-600 font-bold py-4 px-6 rounded-2xl shadow-sm transition-colors flex items-center justify-center gap-3 text-lg"
            >
              <RotateCcw className={cn("w-6 h-6", isRefreshing && "animate-spin")} />
              Check for Existing Data
            </button>

            <div className="mt-8 flex items-center gap-6">
              <button onClick={() => setIsClearConfirmOpen(true)} className="text-red-500 font-medium flex items-center gap-2">
                 <RotateCcw className="w-4 h-4" /> Clear All Data
              </button>
              <button onClick={logOut} className="text-gray-400 font-medium flex items-center gap-2">
                 <LogOut className="w-4 h-4" /> Sign Out
              </button>
            </div>
          </div>
        ) : pendingInFilter === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in zoom-in duration-500">
            <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mb-6">
              <Check className="w-12 h-12 text-green-600" />
            </div>
            <h2 className="text-3xl font-bold mb-2 tracking-tight">Sifting Complete!</h2>
            <p className="text-gray-500 mb-8 text-lg">
              You've sifted through all contacts in this view. All {contacts.length} decisions are safely stored in your database and will never be deleted automatically.
            </p>
            
            <div className="w-full space-y-4">
              <button 
                onClick={exportCSV}
                className="w-full bg-indigo-600 text-white font-bold py-4 px-6 rounded-2xl shadow-lg transition-colors flex items-center justify-center gap-2 text-lg"
              >
                <Download className="w-6 h-6" /> Export {activeFilter === 'all' ? 'All' : 'This File'}
              </button>
              
              <button 
                onClick={() => setIsHistoryOpen(true)}
                className="w-full bg-white border-2 border-gray-200 text-gray-700 font-bold py-4 px-6 rounded-2xl shadow-sm transition-colors flex items-center justify-center gap-2 text-lg"
              >
                <FileText className="w-6 h-6" /> View All Decisions
              </button>
              
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="w-full bg-indigo-50 text-indigo-700 font-bold py-4 px-6 rounded-2xl shadow-sm transition-colors flex items-center justify-center gap-2 text-lg"
              >
                <Upload className="w-6 h-6" /> Import Another CSV
              </button>
              
              {stats.park > 0 && (
                <button 
                  onClick={reviewParked}
                  className="w-full bg-amber-100 text-amber-800 font-bold py-4 px-6 rounded-2xl shadow-sm transition-colors flex items-center justify-center gap-2 text-lg"
                >
                  <RotateCcw className="w-6 h-6" /> Review {stats.park} Parked
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col relative p-4 pb-0">
            {/* Card Stack */}
            <div className="relative flex-1 w-full mb-4">
              {filteredPending.slice(0, 2).reverse().map((contact, idx) => {
                const isTop = idx === filteredPending.slice(0, 2).length - 1;
                return (
                  <SwipeableCard 
                    key={contact.id}
                    contact={contact} 
                    isTop={isTop} 
                    onDecision={handleDecision}
                    onUpdate={(updates) => updateContact(contact.id, updates)}
                    isEditing={isEditing}
                    setIsEditing={setIsEditing}
                  />
                );
              })}
            </div>

            {/* Action Buttons (5 main buttons) */}
            {!isEditing && (
              <div className="flex items-center justify-between w-full px-2 pb-4">
                <ActionButton icon={<X />} color="text-red-500" bg="bg-red-50" border="border-red-100" onClick={() => handleDecision('bin')} />
                <ActionButton icon={<Pause />} color="text-amber-500" bg="bg-amber-50" border="border-amber-100" onClick={() => handleDecision('park')} />
                <ActionButton icon={<Star />} color="text-purple-500" bg="bg-purple-50" border="border-purple-100" onClick={() => handleDecision('priority')} />
                <ActionButton icon={<MapPin />} color="text-blue-500" bg="bg-blue-50" border="border-blue-100" onClick={() => handleDecision('meet')} />
                <ActionButton icon={<Check />} color="text-green-500" bg="bg-green-50" border="border-green-100" onClick={() => handleDecision('keep')} />
              </div>
            )}

            {/* Utility Bar (Undo, Met, Note) */}
            {!isEditing && (
              <div className="flex items-center justify-center gap-8 pb-6 pt-2 border-t border-gray-200/60">
                <button 
                  onClick={handleUndo}
                  disabled={history.length === 0}
                  className="flex flex-col items-center gap-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 transition-colors"
                >
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center"><Undo2 className="w-5 h-5" /></div>
                  <span className="text-[10px] font-bold uppercase tracking-wider">Undo</span>
                </button>
                
                <button 
                  onClick={toggleMet}
                  className={cn(
                    "flex flex-col items-center gap-1 transition-colors",
                    currentContact?.met ? "text-green-600" : "text-gray-400 hover:text-gray-700"
                  )}
                >
                  <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", currentContact?.met ? "bg-green-100" : "bg-gray-100")}><Handshake className="w-5 h-5" /></div>
                  <span className="text-[10px] font-bold uppercase tracking-wider">Met</span>
                </button>

                <button 
                  onClick={openNoteSheet}
                  className={cn(
                    "flex flex-col items-center gap-1 transition-colors",
                    currentContact?.notes ? "text-indigo-600" : "text-gray-400 hover:text-gray-700"
                  )}
                >
                  <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", currentContact?.notes ? "bg-indigo-100" : "bg-gray-100")}><PenLine className="w-5 h-5" /></div>
                  <span className="text-[10px] font-bold uppercase tracking-wider">Note</span>
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {/* Note Bottom Sheet */}
      <AnimatePresence>
        {isNoteSheetOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsNoteSheetOpen(false)}
              className="absolute inset-0 bg-black/40 z-40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="absolute bottom-0 left-0 right-0 bg-white rounded-t-3xl shadow-2xl z-50 flex flex-col h-[50dvh]"
            >
              <div className="w-full flex justify-center pt-3 pb-2">
                <div className="w-12 h-1.5 bg-gray-300 rounded-full" />
              </div>
              <div className="px-6 pb-6 flex-1 flex flex-col">
                <h3 className="text-xl font-bold mb-4 text-gray-900">Add Note</h3>
                <textarea
                  autoFocus
                  value={currentNote}
                  onChange={(e) => setCurrentNote(e.target.value)}
                  className="flex-1 w-full p-4 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-none text-lg"
                  placeholder="Type your note here..."
                />
                <button
                  onClick={saveNote}
                  className="mt-4 w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-6 rounded-2xl shadow-lg transition-colors text-lg"
                >
                  Save Note
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Export Modal / Fallback */}
      <AnimatePresence>
        {isExportModalOpen && (
          <div className="absolute inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsExportModalOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-3xl shadow-2xl z-10 w-full max-w-sm p-6 flex flex-col"
            >
              <h3 className="text-xl font-bold mb-2">Export Complete</h3>
              <p className="text-gray-500 mb-6">
                Your CSV file should have started downloading. If it didn't, it might be blocked by your browser. You can try downloading again or copy the data to your clipboard.
              </p>
              
              <div className="flex flex-col gap-3">
                <button
                  onClick={downloadCsvAgain}
                  className="w-full bg-indigo-600 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" /> Download Again
                </button>
                <button
                  onClick={copyExportToClipboard}
                  className="w-full bg-white border-2 border-indigo-600 text-indigo-600 font-bold py-3 rounded-xl flex items-center justify-center gap-2"
                >
                  <FileText className="w-5 h-5" /> Copy to Clipboard
                </button>
                <button
                  onClick={() => setIsExportModalOpen(false)}
                  className="w-full bg-gray-100 text-gray-700 font-bold py-3 rounded-xl"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Clear Data Confirmation Modal */}
      <AnimatePresence>
        {isClearConfirmOpen && (
          <div className="absolute inset-0 z-[110] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsClearConfirmOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-3xl shadow-2xl z-10 w-full max-w-sm p-6 flex flex-col"
            >
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4 mx-auto">
                <RotateCcw className="w-8 h-8 text-red-600" />
              </div>
              <h3 className="text-xl font-bold mb-2 text-center">Clear Data?</h3>
              <p className="text-gray-500 mb-6 text-center">
                {activeFilter === 'all' 
                  ? "This will permanently delete all contacts and decisions from your account." 
                  : `This will permanently delete all contacts and decisions from "${activeFilter}".`}
                This action cannot be undone.
              </p>
              
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => clearData(activeFilter === 'all' ? 'all' : 'current')}
                  className="w-full bg-red-600 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2"
                >
                  Yes, Clear {activeFilter === 'all' ? 'Everything' : 'This File'}
                </button>
                {activeFilter !== 'all' && (
                  <button
                    onClick={() => clearData('all')}
                    className="w-full bg-red-100 text-red-700 font-bold py-3 rounded-xl"
                  >
                    Clear All Files
                  </button>
                )}
                <button
                  onClick={() => setIsClearConfirmOpen(false)}
                  className="w-full bg-gray-100 text-gray-700 font-bold py-3 rounded-xl"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* History / All Decisions View */}
      <AnimatePresence>
        {isHistoryOpen && (
          <motion.div 
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="absolute inset-0 bg-white z-[90] flex flex-col"
          >
            <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-white sticky top-0">
              <button onClick={() => setIsHistoryOpen(false)} className="p-2 -ml-2 text-gray-500">
                <ChevronRight className="w-6 h-6 rotate-180" />
              </button>
              <h3 className="font-bold text-lg">All Decisions</h3>
              <button onClick={() => setIsClearConfirmOpen(true)} className="p-2 text-red-500">
                <RotateCcw className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {contacts.filter(c => c.status !== 'pending').length === 0 ? (
                <div className="text-center py-20 text-gray-400">No decisions made yet.</div>
              ) : (
                contacts.filter(c => c.status !== 'pending').map(contact => (
                  <div key={contact.id} className="p-4 rounded-2xl border border-gray-100 bg-gray-50 flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="font-bold truncate">{contact.name}</div>
                      <div className="text-xs text-gray-500 truncate">{contact.company}</div>
                    </div>
                    <div className={cn(
                      "px-2 py-1 rounded-lg text-[10px] font-black uppercase",
                      contact.status === 'keep' ? "bg-green-100 text-green-700" :
                      contact.status === 'bin' ? "bg-red-100 text-red-700" :
                      contact.status === 'meet' ? "bg-blue-100 text-blue-700" :
                      contact.status === 'park' ? "bg-amber-100 text-amber-700" :
                      "bg-purple-100 text-purple-700"
                    )}>
                      {contact.status === 'meet' ? 'MET' : contact.status}
                    </div>
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <input 
        type="file" 
        accept=".csv" 
        multiple
        className="hidden" 
        ref={fileInputRef}
        onChange={(e) => {
          handleFileUpload(e);
          // Reset value so the same file can be uploaded again if needed
          e.target.value = '';
        }}
        disabled={isUploading}
      />
    </div>
  );
}

function ActionButton({ icon, color, bg, border, onClick }: { icon: React.ReactNode, color: string, bg: string, border: string, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "w-14 h-14 rounded-full shadow-md border-2 flex items-center justify-center transition-transform active:scale-90",
        color, bg, border
      )}
    >
      {React.cloneElement(icon as React.ReactElement, { className: "w-7 h-7" })}
    </button>
  );
}

function SwipeableCard({ 
  contact, 
  isTop, 
  onDecision,
  onUpdate,
  isEditing,
  setIsEditing
}: { 
  contact: Contact; 
  isTop: boolean;
  onDecision: (decision: Decision) => void | Promise<void>;
  onUpdate?: (updates: Partial<Contact>) => void | Promise<void>;
  isEditing: boolean;
  setIsEditing: (val: boolean) => void;
  key?: any;
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-10, 10]);
  
  const [editName, setEditName] = useState(contact.name);
  const [editCompany, setEditCompany] = useState(contact.company);

  useEffect(() => {
    setEditName(contact.name);
    setEditCompany(contact.company);
    setIsEditing(false);
  }, [contact, setIsEditing]);

  const handleSaveEdit = () => {
    if (onUpdate) {
      onUpdate({ name: editName, company: editCompany });
    }
    setIsEditing(false);
  };

  // Indicators opacity
  const nopeOpacity = useTransform(x, [-100, -50, 0], [1, 0, 0]);
  const likeOpacity = useTransform(x, [0, 50, 100], [0, 0, 1]);
  const meetOpacity = useTransform(y, [-100, -50, 0], [1, 0, 0]);

  const handleDragEnd = (event: any, info: PanInfo) => {
    if (isEditing) return; // Prevent swipe while editing
    const swipeThreshold = 100;
    const velocityThreshold = 500;

    const isSwipeRight = info.offset.x > swipeThreshold || info.velocity.x > velocityThreshold;
    const isSwipeLeft = info.offset.x < -swipeThreshold || info.velocity.x < -velocityThreshold;
    const isSwipeUp = info.offset.y < -swipeThreshold || info.velocity.y < -velocityThreshold;

    if (isSwipeRight) {
      onDecision('keep');
    } else if (isSwipeLeft) {
      onDecision('bin');
    } else if (isSwipeUp && Math.abs(info.offset.y) > Math.abs(info.offset.x)) {
      onDecision('meet');
    }
  };

  // Extract details from originalData
  let details: any = {};
  try {
    details = JSON.parse(contact.originalData);
  } catch (e) {}

  const getField = (regex: RegExp) => {
    const key = Object.keys(details).find(k => regex.test(k));
    return key ? details[key] : null;
  };

  const jobTitle = getField(/title|role|position/i);
  const profession = getField(/profession|occupation/i);
  const sector = getField(/sector|industry/i);
  const location = getField(/location|city|country|address/i);
  const email = getField(/email/i);
  const linkedin = getField(/linkedin/i);
  const website = getField(/website|url/i);
  
  // Determine category
  let categoryTag = { label: 'UNCLEAR', color: 'bg-amber-100 text-amber-800 border-amber-200' };
  const typeStr = String(getField(/type|category|role/i) || '').toLowerCase();
  if (typeStr.includes('client')) {
    categoryTag = { label: 'CLIENT', color: 'bg-green-100 text-green-800 border-green-200' };
  } else if (typeStr.includes('consultant')) {
    categoryTag = { label: 'CONSULTANT', color: 'bg-blue-100 text-blue-800 border-blue-200' };
  }

  return (
    <motion.div
      className={cn(
        "absolute inset-0 w-full h-full bg-white rounded-3xl shadow-xl border border-gray-200 flex flex-col overflow-hidden origin-bottom",
        !isTop && "pointer-events-none"
      )}
      style={isTop ? { x, y, rotate } : { scale: 0.95, y: 12, opacity: 0.9 }}
      drag={isTop && !isEditing ? true : false}
      dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }}
      dragElastic={0.9}
      onDragEnd={handleDragEnd}
      whileTap={{ cursor: 'grabbing' }}
      initial={isTop ? { scale: 0.95, y: 20, opacity: 0 } : false}
      animate={{ scale: 1, y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      {/* Swipe Indicators */}
      {!isEditing && (
        <>
          <motion.div 
            className="absolute top-10 right-6 border-4 border-green-500 text-green-500 font-black text-4xl px-4 py-1 rounded-xl rotate-12 z-20 bg-white/80 backdrop-blur-sm"
            style={{ opacity: likeOpacity }}
          >
            KEEP ✓
          </motion.div>
          <motion.div 
            className="absolute top-10 left-6 border-4 border-red-500 text-red-500 font-black text-4xl px-4 py-1 rounded-xl -rotate-12 z-20 bg-white/80 backdrop-blur-sm"
            style={{ opacity: nopeOpacity }}
          >
            BIN ✗
          </motion.div>
          <motion.div 
            className="absolute bottom-1/4 left-1/2 -translate-x-1/2 border-4 border-blue-500 text-blue-500 font-black text-4xl px-4 py-1 rounded-xl z-20 bg-white/80 backdrop-blur-sm"
            style={{ opacity: meetOpacity }}
          >
            MET ↑
          </motion.div>
        </>
      )}

      {/* Card Content */}
      <div className="flex-1 flex flex-col p-6 overflow-y-auto hide-scrollbar">
        
        {/* Top Row: Category & Met Badge */}
        <div className="flex justify-between items-start mb-4">
          <div className={cn("px-3 py-1 rounded-full text-xs font-bold tracking-wider border", categoryTag.color)}>
            {categoryTag.label}
          </div>
          <div className="flex gap-2">
            <button 
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (isEditing) {
                  // Cancel
                  setEditName(contact.name);
                  setEditCompany(contact.company);
                }
                setIsEditing(!isEditing);
              }}
              className={cn(
                "p-2 rounded-full transition-colors",
                isEditing ? "bg-red-100 text-red-600" : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              )}
            >
              {isEditing ? <X className="w-4 h-4" /> : <PenLine className="w-4 h-4" />}
            </button>
            {contact.met && (
              <div className="bg-green-500 text-white px-3 py-1 rounded-full text-xs font-bold tracking-wider flex items-center gap-1 shadow-sm">
                <Handshake className="w-3 h-3" /> MET
              </div>
            )}
          </div>
        </div>

        {/* Name & Company */}
        {isEditing ? (
          <div className="space-y-4 mb-6" onPointerDown={(e) => e.stopPropagation()}>
            <div>
              <label className="text-[10px] font-black text-indigo-600 uppercase mb-1 block">Name</label>
              <input 
                type="text" 
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full text-2xl font-bold border-b-2 border-indigo-600 outline-none py-1"
                autoFocus
              />
            </div>
            <div>
              <label className="text-[10px] font-black text-indigo-600 uppercase mb-1 block">Company / Title</label>
              <input 
                type="text" 
                value={editCompany}
                onChange={(e) => setEditCompany(e.target.value)}
                className="w-full text-lg font-medium border-b-2 border-indigo-600 outline-none py-1 text-gray-600"
              />
            </div>
            <div className="flex gap-2">
              <button 
                onClick={handleSaveEdit}
                className="flex-1 bg-indigo-600 text-white font-bold py-3 rounded-xl shadow-md active:scale-95 transition-transform"
              >
                Save
              </button>
              <button 
                onClick={() => {
                  setEditName(contact.name);
                  setEditCompany(contact.company);
                  setIsEditing(false);
                }}
                className="flex-1 bg-gray-100 text-gray-700 font-bold py-3 rounded-xl active:scale-95 transition-transform"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-4xl font-black text-gray-900 leading-tight mb-1 tracking-tight">
              {contact.name}
            </h2>
            {contact.company && (
              <h3 className="text-xl font-medium text-gray-500 mb-6 leading-snug">
                {contact.company}
              </h3>
            )}
          </>
        )}

        {/* Details List */}
        <div className="space-y-3 mt-2">
          {jobTitle && <DetailRow icon={<Briefcase />} text={jobTitle} />}
          {profession && <DetailRow icon={<UserCircle />} text={profession} />}
          {sector && <DetailRow icon={<Briefcase />} text={sector} />}
          {location && <DetailRow icon={<Map />} text={location} />}
          
          {email && (
            <a href={`mailto:${email}`} className="flex items-center gap-3 text-indigo-600 hover:text-indigo-800 py-1" onPointerDown={(e) => e.stopPropagation()}>
              <div className="w-8 h-8 rounded-full bg-indigo-50 flex items-center justify-center shrink-0"><Mail className="w-4 h-4" /></div>
              <span className="font-medium truncate">{email}</span>
            </a>
          )}
          
          {linkedin && (
            <a href={linkedin} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-blue-600 hover:text-blue-800 py-1" onPointerDown={(e) => e.stopPropagation()}>
              <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0"><Linkedin className="w-4 h-4" /></div>
              <span className="font-medium truncate">LinkedIn Profile</span>
            </a>
          )}
          
          {website && (
            <a href={website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 text-gray-600 hover:text-gray-900 py-1" onPointerDown={(e) => e.stopPropagation()}>
              <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0"><Globe className="w-4 h-4" /></div>
              <span className="font-medium truncate">{website}</span>
            </a>
          )}
          
          {contact.sourceFile && (
            <DetailRow icon={<FileText />} text={`Source: ${contact.sourceFile}`} className="text-xs text-gray-400 mt-4" />
          )}
        </div>
      </div>

      {/* Note Section (Bottom of card) */}
      {contact.notes && (
        <div className="bg-indigo-50 p-4 border-t border-indigo-100">
          <div className="flex items-start gap-2 text-indigo-900">
            <PenLine className="w-4 h-4 mt-0.5 shrink-0 text-indigo-500" />
            <p className="text-sm font-medium leading-snug">{contact.notes}</p>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function DetailRow({ icon, text, className = "text-gray-700" }: { icon: React.ReactNode, text: string, className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center shrink-0 text-gray-400">
        {React.cloneElement(icon as React.ReactElement, { className: "w-4 h-4" })}
      </div>
      <span className="font-medium truncate">{text}</span>
    </div>
  );
}


